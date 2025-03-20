import express from 'express';
import http from 'http';
import {fileURLToPath} from 'url';
import path from 'path';
import bodyParser from 'body-parser';
import {ffmpegModule} from './function/ffmpegFunction.js';
import {kioskFunction} from './function/kioskFunction.js';

const app = express();
const port = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true,
}));
app.use("/", express.static(path.join(__dirname, "public")));

app.get('/save-last-minute', async (req, res) => {
    try {
        const savedFilePath = await ffmpegModule.saveLastMinute();
        res.status(200).json({
            message: 'Salvataggio dell\'ultimo minuto completato.', filePath: savedFilePath
        });
    } catch (err) {
        console.error('Errore API save-last-minute:', err);
        res.status(500).json({
            message: 'Errore durante il salvataggio dell\'ultimo minuto.', error: err.message
        });
    }
});
app.get('/cleanup-and-stop', async (req, res) => {
    try {
        const result = await ffmpegModule.cleanupAndStop();
        res.status(200).json({
            message: 'Registrazione interrotta e buffer puliti.', result
        });
    } catch (err) {
        console.error('Errore API cleanup-and-stop:', err);
        res.status(500).json({
            message: 'Errore durante l\'arresto del VAR.', error: err.message
        });
    }
})
const server = app.listen(port, async () => {
    console.log(`Server in ascolto su http://localhost:${port}`);
    await ffmpegModule.startRecording();
    setTimeout(() => {
        kioskFunction.launchBrowserInKioskMode(port);
    }, 1000);
});

