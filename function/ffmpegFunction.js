import {createRequire} from "module";
import {fileURLToPath} from 'url';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';

const require = createRequire(import.meta.url);
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUFFER_DURATION = 60; // Buffer di 60 secondi
const SEGMENT_DURATION = 0.5; // Ogni segmento dura 0.5 secondi
const SEGMENTS_COUNT = Math.ceil(BUFFER_DURATION / SEGMENT_DURATION);

// Configurazione specifica per Lubuntu
const VIDEO_DEVICE = process.env.VIDEO_DEVICE || '/dev/video0';
const OUTPUT_DIR = path.join(__dirname, '../recordings');
const BUFFER_DIR = '/dev/shm/buffer';
const SEGMENT_PATTERN = path.join(BUFFER_DIR, 'segment%03d.mp4');

// Assicurati che le directory necessarie esistano
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, {recursive: true});
if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, {recursive: true});
ffmpeg.setFfmpegPath(ffmpegStatic);
let ffmpegProcess = null;
let isRecording = false;
let segmentCreationTimes = new Map(); // Traccia quando è stato creato ogni segmento
let deviceCheckInterval = null;
let reconnectTimeout = null;
let autoReconnect = true; // Flag per controllare se tentare la riconnessione automatica
let isReconnecting = false; // Flag per indicare che siamo in fase di riconnessione

// Controlla se il dispositivo di acquisizione è collegato
const isDeviceConnected = () => {
    return fs.existsSync(VIDEO_DEVICE);
};

// Attende che il dispositivo sia collegato
const waitForDevice = (timeout = 1000) => {
    return new Promise(resolve => {
        if (isDeviceConnected()) {
            console.log(`Dispositivo ${VIDEO_DEVICE} trovato!`);
            resolve(true);
            return;
        }

        console.log(`In attesa del dispositivo ${VIDEO_DEVICE}...`);
        const checkInterval = setInterval(() => {
            if (isDeviceConnected()) {
                clearInterval(checkInterval);
                console.log(`Dispositivo ${VIDEO_DEVICE} collegato!`);
                resolve(true);
            }
        }, timeout);
    });
};

// Monitora lo stato del dispositivo durante la registrazione
const startDeviceMonitoring = () => {
    if (deviceCheckInterval) {
        clearInterval(deviceCheckInterval);
    }

    deviceCheckInterval = setInterval(() => {
        if (isRecording && !isDeviceConnected()) {
            console.log(`Dispositivo ${VIDEO_DEVICE} scollegato durante la registrazione!`);
            handleDeviceDisconnection();
        }
    }, 1000); // Controlla ogni secondo
};

// Gestisce lo scollegamento del dispositivo
const handleDeviceDisconnection = async () => {
    console.log('Gestione disconnessione dispositivo...');

    // Ferma la registrazione attuale
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
        isRecording = false;
    }

    // Pulisci i buffer
    await cleanupSegments();
    segmentCreationTimes.clear();

    // Se l'auto-riconnessione è abilitata, attendi che il dispositivo si riconnetta
    if (autoReconnect) {
        console.log('In attesa della riconnessione del dispositivo...');
        if (reconnectTimeout) clearTimeout(reconnectTimeout);

        isReconnecting = true; // Imposta lo stato di riconnessione

        reconnectTimeout = setTimeout(async () => {
            await waitForDevice();
            console.log('Riavvio della registrazione dopo riconnessione...');
            try {
                await ffmpegModule.startRecording();
                // Attendiamo che inizino ad accumularsi i segmenti
                setTimeout(() => {
                    isReconnecting = false; // Riconnessione completata
                }, 5000);
            } catch (err) {
                console.error('Errore durante il riavvio della registrazione:', err);
                // Riprova dopo un po'
                reconnectTimeout = setTimeout(() => handleDeviceDisconnection(), 2000);
            }
        }, 1000);
    }
};

export const ffmpegModule = {
    startRecording: async function () {
        if (isRecording) {
            console.log('La registrazione è già in corso.');
            return;
        }

        try {
            // Controlla se il dispositivo è collegato, altrimenti attendi
            if (!isDeviceConnected()) {
                console.log(`Dispositivo ${VIDEO_DEVICE} non trovato. In attesa...`);
                await waitForDevice();
            }

            await cleanupSegments();
            segmentCreationTimes.clear();

            return new Promise((resolve, reject) => {
                const process = ffmpeg()
                    .input(VIDEO_DEVICE)
                    .inputFormat('v4l2')
                    .inputOptions([
                        '-framerate 30',
                        '-video_size 1280x720'
                    ])
                    .videoCodec('libx264')
                    .videoBitrate('2500k')
                    .outputOptions([
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
                        '-flush_packets 1',  // Force packet flushing
                        '-fflags +genpts'    // Generate presentation timestamps
                    ])
                    .on('start', (commandLine) => {
                        console.log(`FFmpeg sta registrando in segmenti con dispositivo: ${VIDEO_DEVICE}`);
                        ffmpegProcess = process;
                        isRecording = true;
                        setupSegmentWatcher();
                        startDeviceMonitoring(); // Avvia il monitoraggio del dispositivo
                        resolve();
                    })
                    .on('error', (err) => {
                        if (err && err.message && err.message.includes('SIGKILL')) {
                            console.log('FFmpeg process terminated');
                        } else if (err && (
                            err.message.includes('No such file or directory') ||
                            err.message.includes('Connection refused') ||
                            err.message.includes('Permission denied') ||
                            err.message.includes('Cannot open video device')
                        )) {
                            console.log('Errore di accesso al dispositivo:', err.message);
                            handleDeviceDisconnection();
                        } else {
                            console.error('Errore in FFmpeg:', err);
                            isRecording = false;
                            ffmpegProcess = null;

                            // Se c'è un errore non correlato alla disconnessione, riprova dopo un po'
                            if (autoReconnect) {
                                console.log('Tentativo di riavvio dopo errore...');
                                setTimeout(() => {
                                    this.startRecording().catch(e => {
                                        console.error('Errore durante il riavvio:', e);
                                    });
                                }, 2000);
                            }

                            reject(err);
                        }
                    })
                    .save(SEGMENT_PATTERN);
            });
        } catch (err) {
            console.error('Errore durante l\'avvio della registrazione:', err);
            isRecording = false;

            // Anche in caso di errore, riprova se autoReconnect è true
            if (autoReconnect) {
                console.log('Tentativo di riavvio dopo errore...');
                setTimeout(() => {
                    this.startRecording().catch(e => {
                        console.error('Errore durante il riavvio:', e);
                    });
                }, 2000);
            }

            throw err;
        }
    },

    saveLastMinute: async () => {
        if (!isRecording) {
            console.error('Registrazione non attiva. Avviare prima la registrazione.');
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputFile = path.join(OUTPUT_DIR, `recording-${timestamp}.mp4`);
        const listFile = path.join(BUFFER_DIR, 'filelist.txt');

        try {
            console.log("Preparazione al salvataggio del buffer video...");

            // First, send a signal to ffmpeg to flush its buffers
            if (ffmpegProcess && ffmpegProcess.kill) {
                // SIGUSR1 is often used to signal applications to flush buffers
                try {
                    process.kill(ffmpegProcess.pid, 'SIGUSR1');
                } catch (e) {
                    // Ignore errors, as some platforms may not support this signal
                }
            }

            // Increase delay to ensure segments are written
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Manually synchronize all segments from the buffer directory
            const files = await fsPromises.readdir(BUFFER_DIR);
            const allSegments = files.filter(file => file.startsWith('segment') && file.endsWith('.mp4'));

            // Force a file stat update to get the most accurate timestamps
            for (const segment of allSegments) {
                try {
                    const stats = await fsPromises.stat(path.join(BUFFER_DIR, segment));
                    segmentCreationTimes.set(segment, stats.mtime.getTime());
                } catch (err) {
                    segmentCreationTimes.set(segment, Date.now());
                }
            }

            // Get updated segments list
            const segments = await getLastMinuteSegments();
            if (segments.length === 0) {
                if (isReconnecting) {
                    console.log('Riconnessione, attendi');
                    return null; // Ritorna null invece di lanciare un'eccezione
                } else {
                    throw new Error('Nessun segmento disponibile per il salvataggio');
                }
            }
            console.log(`Trovati ${segments.length} segmenti da unire (max 60 secondi)`);
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
                        '-movflags +faststart'
                    ])
                    .on('end', resolve)
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

            // Ferma il monitoraggio del dispositivo
            if (deviceCheckInterval) {
                clearInterval(deviceCheckInterval);
                deviceCheckInterval = null;
            }

            // Cancella eventuali timeout di riconnessione
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
            }

            console.log('Registrazione interrotta.');
        } else {
            console.log('Nessuna registrazione attiva da interrompere.');
        }
    },

    cleanupAndStop: async function () {
        try {
            // Disabilita temporaneamente la riconnessione automatica
            autoReconnect = false;

            // Stop the ffmpeg recording if active
            if (ffmpegProcess) {
                ffmpegProcess.kill('SIGKILL');
                ffmpegProcess = null;
                isRecording = false;
                console.log('Registrazione interrotta.');
            } else {
                console.log('Nessuna registrazione attiva da interrompere.');
            }

            // Ferma il monitoraggio del dispositivo
            if (deviceCheckInterval) {
                clearInterval(deviceCheckInterval);
                deviceCheckInterval = null;
            }

            // Cancella eventuali timeout di riconnessione
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
            }

            // Clear segment tracking
            segmentCreationTimes.clear();

            // Clean up segment files
            await cleanupSegments();

            // Riabilita la riconnessione automatica per usi futuri
            autoReconnect = true;

            return {success: true, message: 'Registrazione interrotta e buffer puliti.'};
        } catch (err) {
            console.error('Errore durante la pulizia e l\'arresto:', err);

            // Riabilita la riconnessione automatica anche in caso di errore
            autoReconnect = true;
            throw err;
        }
    },

    // Metodo per verificare manualmente lo stato del dispositivo
    isDeviceConnected: () => {
        return isDeviceConnected();
    },

    // Metodo per disabilitare/abilitare la riconnessione automatica
    setAutoReconnect: (enable) => {
        autoReconnect = Boolean(enable);
        return autoReconnect;
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

    // Leggi tutti i segmenti nel buffer
    const files = await fsPromises.readdir(BUFFER_DIR);
    const segments = files.filter(file => file.startsWith('segment') && file.endsWith('.mp4'));

    // Riempi il map per tutti i segmenti che non sono ancora tracciati
    for (const segment of segments) {
        if (!segmentCreationTimes.has(segment)) {
            // Se non abbiamo tracciato questo segmento, usa il tempo di modifica
            try {
                const stats = await fsPromises.stat(path.join(BUFFER_DIR, segment));
                segmentCreationTimes.set(segment, stats.mtime.getTime());
            } catch (err) {
                // Se non riusciamo a ottenere le statistiche, usa l'ora corrente
                segmentCreationTimes.set(segment, now);
            }
        }
    }

    // Filtra e ordina i segmenti per tempo di creazione
    return segments
        .filter(segment => {
            const creationTime = segmentCreationTimes.get(segment) || 0;
            return creationTime >= cutoffTime;
        })
        .sort((a, b) => {
            // Ordina per numero di segmento in modo numerico
            const numA = parseInt(a.match(/segment(\d+)\.mp4/)[1]);
            const numB = parseInt(b.match(/segment(\d+)\.mp4/)[1]);
            return numA - numB;
        });
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
    if (deviceCheckInterval) {
        clearInterval(deviceCheckInterval);
    }
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }
});

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, () => {
        if (ffmpegProcess) {
            ffmpegProcess.kill('SIGKILL');
        }
        if (deviceCheckInterval) {
            clearInterval(deviceCheckInterval);
        }
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
        }
        process.exit(0);
    });
});