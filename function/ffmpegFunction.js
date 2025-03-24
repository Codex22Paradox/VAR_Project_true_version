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
            throw new Error('Dispositivo di acquisizione non disponibile');
        }

        try {
            await cleanupSegments();
            segmentCreationTimes.clear();
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
                        '-force_key_frames expr:gte(t,n_forced*0.5)', // Forza keyframe ogni 0.5 secondi per un taglio più preciso
                        '-sc_threshold 0' // Disabilita la rilevazione del cambio di scena per evitare ritardi
                    ])
                    .on('start', (commandLine) => {
                        console.log(`FFmpeg sta registrando in segmenti con dispositivo: ${VIDEO_DEVICE}`);
                        ffmpegProcess = process;
                        isRecording = true;
                        setupSegmentWatcher();
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
                            reject(err);
                        }
                    })
                    .save(SEGMENT_PATTERN);
            });
        } catch (err) {
            console.error('Errore durante l\'avvio della registrazione:', err);
            isRecording = false;
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
                    this.startRecording().catch(err => {
                        console.error('Errore nel riavvio della registrazione:', err);
                        // Se fallisce, riavvia il processo di attesa
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

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputFile = path.join(OUTPUT_DIR, `recording-${timestamp}.mp4`);
        const listFile = path.join(BUFFER_DIR, 'filelist.txt');

        try {
            const segments = await getLastMinuteSegments();
            if (segments.length === 0)
                throw new Error('Nessun segmento disponibile per il salvataggio');
            console.log(`Trovati ${segments.length} segmenti da unire (max 60 secondi)`);

            // Creare il file di lista in modo più efficiente
            const fileContent = segments.map(file =>
                `file '${path.join(BUFFER_DIR, file).replace(/\\/g, '/')}'`
            ).join('\n');
            await fsPromises.writeFile(listFile, fileContent);

            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(listFile)
                    .inputOptions(['-f concat', '-safe 0'])
                    .outputOptions([
                        '-c copy',                // Usa copy per evitare ricodifica (più veloce)
                        '-movflags +faststart',   // Ottimizzazione per il web
                        '-fflags +genpts',        // Genera PTS per streaming più fluido
                        '-flags +global_header'   // Ottimizzazione header
                    ])
                    .on('start', () => console.log('Inizio concatenazione segmenti...'))
                    .on('progress', (progress) => {
                        // Opzionale: monitoraggio progresso in caso di file più grandi
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
            segmentCreationTimes.clear();
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
                console.log('Registrazione interrotta.');
            } else {
                console.log('Nessuna registrazione attiva da interrompere.');
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
    const watcher = fs.watch(BUFFER_DIR, (eventType, filename) => {
        if (eventType === 'rename' && filename && filename.startsWith('segment') && filename.endsWith('.mp4')) {
            // Quando un nuovo file viene creato, tieni traccia dell'ora
            segmentCreationTimes.set(filename, Date.now());
        }
    });

    // Se si ferma la registrazione, ferma anche il watcher
    if (ffmpegProcess) {
        ffmpegProcess.on('end', () => watcher.close());
        ffmpegProcess.on('error', () => watcher.close());
    }
}

const getLastMinuteSegments = async () => {
    const now = Date.now();
    const cutoffTime = now - (BUFFER_DURATION * 1000);

    try {
        // Leggi tutti i segmenti nel buffer
        const files = await fsPromises.readdir(BUFFER_DIR);
        const segments = files.filter(file => file.startsWith('segment') && file.endsWith('.mp4'));

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
        return segmentStats
            .filter(segment => segment.time >= cutoffTime)
            .sort((a, b) => a.num - b.num)
            .map(segment => segment.name);
    } catch (err) {
        console.error('Errore durante la lettura dei segmenti:', err);
        return [];
    }
}

const cleanupSegments = async () => {
    try {
        const files = await fsPromises.readdir(BUFFER_DIR).catch(() => []);
        for (const file of files) {
            if (file.startsWith('segment') && file.endsWith('.mp4')) {
                await fsPromises.unlink(path.join(BUFFER_DIR, file)).catch(() => {
                });
            }
        }
    } catch (err) {
        console.error('Errore durante la pulizia dei segmenti:', err);
    }
}

process.on('exit', () => {
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
    }
});

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, () => {
        if (ffmpegProcess) {
            ffmpegProcess.kill('SIGKILL');
        }
        process.exit(0);
    });
});
