import {createRequire} from "module";
import {fileURLToPath} from 'url';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import {exec} from 'child_process';
import {promisify} from 'util';

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUFFER_DURATION = 60; // Buffer di 60 secondi
const SEGMENT_DURATION = 0.5; // Ridotto da 2 a 0.5 secondi per minimizzare il ritardo
const SEGMENTS_COUNT = Math.ceil(BUFFER_DURATION / SEGMENT_DURATION);
const isWindows = process.platform === 'win32';
const RECONNECT_INTERVAL = 5000; // Controlla ogni 5 secondi se il dispositivo è riconnesso
const MIN_SEGMENTS_REQUIRED = 5; // Minimo numero di segmenti necessari per considerare il buffer pronto

// Imposta il nome del dispositivo dinamicamente
const VIDEO_DEVICE = process.env.VIDEO_DEVICE || (isWindows ? 'video=NomeDelTuoDispositivo' : '/dev/video0');
const OUTPUT_DIR = path.join(__dirname, '../recordings');
const BUFFER_DIR = isWindows ? 'C:\\temp\\buffer' : '/dev/shm/buffer';
const SEGMENT_PATTERN = path.join(BUFFER_DIR, 'segment%03d.mp4');

// Assicurati che le directory necessarie esistano
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, {recursive: true});
if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, {recursive: true});
ffmpeg.setFfmpegPath(ffmpegStatic);
let ffmpegProcess = null;
let isRecording = false;
let segmentCreationTimes = new Map(); // Traccia quando è stato creato ogni segmento
let reconnectTimer = null;
let waitingForReconnect = false;
let recordingStartTime = null; // Traccia quando è iniziata la registrazione
let segmentWatcher = null; // Riferimento al watcher per poterlo chiudere
let isBufferReady = false; // Flag per tracciare se il buffer è pronto
let lastSegmentSeen = 0; // Traccia l'ultimo segmento visto per monitorare la creazione

// Funzione per verificare se il dispositivo di acquisizione è collegato
async function isDeviceConnected() {
    if (isWindows) {
        // Su Windows, questa è più complessa. Per semplificare, restituiamo true
        return true;
    } else {
        try {
            // Su Linux verifichiamo se il dispositivo esiste
            await fsPromises.access(VIDEO_DEVICE, fs.constants.F_OK);
            // Verifichiamo anche se il dispositivo è funzionante utilizzando v4l2-ctl
            await execAsync(`v4l2-ctl --device=${VIDEO_DEVICE} --all`);
            return true;
        } catch (err) {
            console.log(`Dispositivo ${VIDEO_DEVICE} non disponibile: ${err.message}`);
            return false;
        }
    }
}

export const ffmpegModule = {
    startRecording: async function () {
        if (isRecording) {
            console.log('La registrazione è già in corso.');
            return;
        }

        // Verifica se il dispositivo è collegato prima di iniziare
        if (!await isDeviceConnected()) {
            console.log('Dispositivo di acquisizione non disponibile. In attesa di riconnessione...');
            this.waitForDeviceAndRestart();
            return {
                status: 'waiting',
                message: 'Dispositivo di acquisizione non disponibile. In attesa di riconnessione...'
            };
        }

        try {
            // Reset completo dello stato
            await cleanupSegments();
            segmentCreationTimes.clear();
            isBufferReady = false;
            lastSegmentSeen = 0;
            recordingStartTime = Date.now();

            // Chiudiamo eventuali watcher precedenti
            if (segmentWatcher) {
                segmentWatcher.close();
                segmentWatcher = null;
            }

            const hwAccel = isWindows ? ['-hwaccel auto'] : [];
            return new Promise((resolve, reject) => {
                const process = ffmpeg()
                    .input(VIDEO_DEVICE)
                    .inputFormat(isWindows ? 'dshow' : 'v4l2')
                    .inputOptions([
                        '-framerate 30',
                        '-video_size 1280x720'
                    ])
                    .videoCodec('libx264')
                    .videoBitrate('2500k')
                    .outputOptions([
                        ...hwAccel,
                        '-preset ultrafast',
                        '-tune zerolatency',
                        '-profile:v baseline',
                        '-level 3.1',
                        '-pix_fmt yuv420p',
                        '-f segment',
                        `-segment_time ${SEGMENT_DURATION}`,
                        `-segment_wrap ${SEGMENTS_COUNT}`,
                        '-reset_timestamps 1',
                        '-avoid_negative_ts make_zero',
                        '-force_key_frames expr:gte(t,n_forced*0.5)', // Forza keyframe ogni 0.5 secondi
                        '-sc_threshold 0' // Disabilita la rilevazione del cambio di scena
                    ])
                    .on('start', (commandLine) => {
                        console.log(`FFmpeg sta registrando in segmenti con dispositivo: ${VIDEO_DEVICE}`);
                        ffmpegProcess = process;
                        isRecording = true;
                        setupSegmentWatcher();
                        console.log("Registrazione avviata con successo, buffer in preparazione...");
                        resolve();
                    })
                    .on('error', (err) => {
                        if (err && err.message && err.message.includes('SIGKILL')) {
                            console.log('FFmpeg process terminated');
                        } else {
                            console.error('Errore in FFmpeg:', err);

                            // Verifica se l'errore è legato alla disconnessione del dispositivo
                            const deviceErrors = [
                                'No such file or directory',
                                'Cannot open video device',
                                'Device or resource busy',
                                'No such device',
                                'Input/output error'
                            ];

                            if (deviceErrors.some(errText => err.message.includes(errText))) {
                                console.log('Dispositivo di acquisizione scollegato. In attesa di riconnessione...');
                                this.waitForDeviceAndRestart();
                            }

                            isRecording = false;
                            ffmpegProcess = null;
                            isBufferReady = false;
                            reject(err);
                        }
                    })
                    .save(SEGMENT_PATTERN);
            });
        } catch (err) {
            console.error('Errore durante l\'avvio della registrazione:', err);
            isRecording = false;
            isBufferReady = false;
            throw err;
        }
    },

    waitForDeviceAndRestart: function () {
        if (waitingForReconnect) return;
        waitingForReconnect = true;

        // Ferma la registrazione se ancora attiva
        if (isRecording) {
            this.stopRecording();
        }

        console.log('In attesa che il dispositivo venga ricollegato...');

        // Cancella eventuali timer precedenti
        if (reconnectTimer) {
            clearInterval(reconnectTimer);
        }

        // Imposta un intervallo per controllare periodicamente il dispositivo
        reconnectTimer = setInterval(async () => {
            try {
                if (await isDeviceConnected()) {
                    console.log('Dispositivo ricollegato! Riavvio della registrazione...');
                    clearInterval(reconnectTimer);
                    reconnectTimer = null;
                    waitingForReconnect = false;

                    // Reset completo dello stato prima di riavviare
                    await cleanupSegments();
                    segmentCreationTimes.clear();
                    recordingStartTime = null;
                    isBufferReady = false;
                    lastSegmentSeen = 0;

                    if (segmentWatcher) {
                        segmentWatcher.close();
                        segmentWatcher = null;
                    }

                    this.startRecording().catch(err => {
                        console.error('Errore nel riavvio della registrazione:', err);
                        this.waitForDeviceAndRestart();
                    });
                }
            } catch (err) {
                console.error('Errore durante il controllo del dispositivo:', err);
            }
        }, RECONNECT_INTERVAL);
    },

    saveLastMinute: async () => {
        if (!isRecording) {
            throw new Error('Registrazione non attiva. Avviare prima la registrazione.');
        }

        // Verifica che la registrazione sia attiva da abbastanza tempo
        const recordingDuration = Date.now() - (recordingStartTime || 0);
        const minRecordingTime = 5000; // 5 secondi minimi

        if (recordingDuration < minRecordingTime) {
            console.log(`Registrazione attiva da soli ${Math.round(recordingDuration / 1000)} secondi, attendere...`);
            return {
                status: 'waiting',
                message: 'Registrazione appena avviata. Attendere qualche secondo.'
            };
        }

        // Verifica se il buffer è pronto
        if (!isBufferReady) {
            console.log("Buffer non ancora pronto. Attendere il riempimento iniziale.");

            // Ottieni lo stato attuale del buffer per reporting
            const files = await fsPromises.readdir(BUFFER_DIR);
            const allSegments = files.filter(file => file.startsWith('segment') && file.endsWith('.mp4'));

            console.log(`Stato attuale: ${allSegments.length}/${MIN_SEGMENTS_REQUIRED} segmenti disponibili`);

            return {
                status: 'waiting',
                message: `Buffer in preparazione (${allSegments.length}/${MIN_SEGMENTS_REQUIRED}). Attendere qualche secondo.`
            };
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputFile = path.join(OUTPUT_DIR, `recording-${timestamp}.mp4`);
        const listFile = path.join(BUFFER_DIR, 'filelist.txt');

        try {
            const segments = await getLastMinuteSegments();
            if (segments.length === 0) {
                console.log('Nessun segmento disponibile per il salvataggio dopo la riconnessione.');

                // Reset dello stato del buffer per forzare una nuova inizializzazione
                isBufferReady = false;

                return {
                    status: 'waiting',
                    message: 'Buffer in reinizializzazione dopo riconnessione. Riprovare tra qualche secondo.'
                };
            }

            console.log(`Trovati ${segments.length} segmenti da unire (max 60 secondi)`);

            // Creare il file di lista
            const fileContent = segments.map(file =>
                `file '${path.join(BUFFER_DIR, file).replace(/\\/g, '/')}'`
            ).join('\n');
            await fsPromises.writeFile(listFile, fileContent);

            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(listFile)
                    .inputOptions(['-f concat', '-safe 0'])
                    .outputOptions([
                        '-c copy',
                        '-movflags +faststart',
                        '-fflags +genpts',
                        '-flags +global_header'
                    ])
                    .on('start', () => console.log('Inizio concatenazione segmenti...'))
                    .on('progress', (progress) => {
                        if (progress && progress.percent) {
                            console.log(`Progresso concatenazione: ${Math.round(progress.percent)}%`);
                        }
                    })
                    .on('end', () => {
                        console.log(`Concatenazione completata in ${outputFile}`);
                        resolve();
                    })
                    .on('error', reject)
                    .save(outputFile);
            });

            console.log(`Salvataggio completato in ${outputFile}!`);
            return outputFile;
        } catch (err) {
            console.error('Errore durante il salvataggio del video:', err);
            throw err;
        } finally {
            if (fs.existsSync(listFile)) {
                await fsPromises.unlink(listFile).catch(() => {
                });
            }
        }
    },

    stopRecording: async () => {
        if (ffmpegProcess) {
            ffmpegProcess.kill('SIGKILL');
            ffmpegProcess = null;
            isRecording = false;
            recordingStartTime = null;
            isBufferReady = false;
            segmentCreationTimes.clear();

            if (segmentWatcher) {
                segmentWatcher.close();
                segmentWatcher = null;
            }

            console.log('Registrazione interrotta.');
        } else {
            console.log('Nessuna registrazione attiva da interrompere.');
        }
    },

    cleanupAndStop: async function () {
        // Clear any reconnect timers
        if (reconnectTimer) {
            clearInterval(reconnectTimer);
            reconnectTimer = null;
            waitingForReconnect = false;
        }

        try {
            // Stop the ffmpeg recording if active
            if (ffmpegProcess) {
                ffmpegProcess.kill('SIGKILL');
                ffmpegProcess = null;
                isRecording = false;
                recordingStartTime = null;
                isBufferReady = false;
                console.log('Registrazione interrotta.');
            } else {
                console.log('Nessuna registrazione attiva da interrompere.');
            }

            // Chiudi il watcher dei segmenti
            if (segmentWatcher) {
                segmentWatcher.close();
                segmentWatcher = null;
            }

            // Clear segment tracking
            segmentCreationTimes.clear();

            // Clean up segment files
            await cleanupSegments();

            return {success: true, message: 'Registrazione interrotta e buffer puliti.'};
        } catch (err) {
            console.error('Errore durante la pulizia e l\'arresto:', err);
            throw err;
        }
    }
};

const setupSegmentWatcher = () => {
    // Chiudi eventuali watcher precedenti
    if (segmentWatcher) {
        segmentWatcher.close();
    }

    segmentWatcher = fs.watch(BUFFER_DIR, async (eventType, filename) => {
        if (eventType === 'rename' && filename && filename.startsWith('segment') && filename.endsWith('.mp4')) {
            // Quando un nuovo file viene creato, tieni traccia dell'ora
            const currentTime = Date.now();
            segmentCreationTimes.set(filename, currentTime);

            // Cerca di estrarre il numero del segmento per monitoraggio
            const match = filename.match(/segment(\d+)\.mp4/);
            if (match) {
                const segNum = parseInt(match[1]);
                lastSegmentSeen = Math.max(lastSegmentSeen, segNum);
            }

            // Verifica se il buffer è pronto basandosi sul numero di segmenti
            if (!isBufferReady) {
                const segments = await getLastMinuteSegments();
                if (segments.length >= MIN_SEGMENTS_REQUIRED) {
                    isBufferReady = true;
                    console.log(`Buffer pronto! ${segments.length} segmenti disponibili.`);
                }

                // Log dettagliato durante l'inizializzazione
                if (segmentCreationTimes.size % 3 === 0 || segmentCreationTimes.size === MIN_SEGMENTS_REQUIRED) {
                    console.log(`Preparazione buffer: ${segmentCreationTimes.size}/${MIN_SEGMENTS_REQUIRED} segmenti creati.`);
                }
            }
        }
    });

    // Se si ferma la registrazione, ferma anche il watcher
    if (ffmpegProcess) {
        ffmpegProcess.on('end', () => {
            if (segmentWatcher) segmentWatcher.close();
            segmentWatcher = null;
        });
        ffmpegProcess.on('error', () => {
            if (segmentWatcher) segmentWatcher.close();
            segmentWatcher = null;
        });
    }
}

const getLastMinuteSegments = async () => {
    const now = Date.now();
    const cutoffTime = now - (BUFFER_DURATION * 1000);

    try {
        // Leggi tutti i segmenti nel buffer
        const files = await fsPromises.readdir(BUFFER_DIR);
        const segments = files.filter(file => file.startsWith('segment') && file.endsWith('.mp4'));

        if (segments.length === 0) {
            console.log("Nessun segmento trovato nel buffer");
            return [];
        }

        // Ottimizzazione: utilizziamo Promise.all per elaborare tutti i segmenti in parallelo
        const segmentStats = await Promise.all(
            segments.map(async segment => {
                if (!segmentCreationTimes.has(segment)) {
                    try {
                        const stats = await fsPromises.stat(path.join(BUFFER_DIR, segment));
                        segmentCreationTimes.set(segment, stats.mtime.getTime());
                    } catch (err) {
                        // In caso di errore, usa l'ora corrente
                        segmentCreationTimes.set(segment, now);
                    }
                }
                return {
                    name: segment,
                    time: segmentCreationTimes.get(segment) || 0,
                    num: parseInt(segment.match(/segment(\d+)\.mp4/)?.[1] || '0')
                };
            })
        );

        // Filtra e ordina i segmenti per tempo di creazione
        const validSegments = segmentStats
            .filter(segment => segment.time >= cutoffTime)
            .sort((a, b) => a.num - b.num)
            .map(segment => segment.name);

        console.log(`Trovati ${validSegments.length} segmenti validi su ${segments.length} totali`);
        return validSegments;
    } catch (err) {
        console.error('Errore durante la lettura dei segmenti:', err);
        return [];
    }
}

const cleanupSegments = async () => {
    try {
        console.log('Pulizia dei segmenti nel buffer...');
        const files = await fsPromises.readdir(BUFFER_DIR).catch(() => []);
        let deletedCount = 0;

        for (const file of files) {
            if (file.startsWith('segment') && file.endsWith('.mp4')) {
                try {
                    await fsPromises.unlink(path.join(BUFFER_DIR, file));
                    deletedCount++;
                } catch (err) {
                    console.error(`Errore eliminando ${file}:`, err.message);
                }
            }
        }

        console.log(`Pulizia completata: ${deletedCount} segmenti rimossi.`);
    } catch (err) {
        console.error('Errore durante la pulizia dei segmenti:', err);
    }
}

process.on('exit', () => {
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
    }
    if (segmentWatcher) {
        segmentWatcher.close();
    }
});

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, () => {
        if (ffmpegProcess) {
            ffmpegProcess.kill('SIGKILL');
        }
        if (segmentWatcher) {
            segmentWatcher.close();
        }
        process.exit(0);
    });
});