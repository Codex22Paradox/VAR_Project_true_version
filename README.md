# VAR_Project

# Come avviare:

## Windows:

Installa lo standalone di ffmpeg da [qui](https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z) e decomprimilo in
una cartella a tua scelta. Aggiungi la cartella bin di ffmpeg al PATH di sistema.
In un terminale digita: ffmpeg -list_devices true -f dshow -i dummy
Scegli il parametro corretto e avvia il programma:
set VIDEO_DEVICE=video="Scheda di acquisizione video USB"
node index.js

## Linux:
Apri un terminale e digita: v4l2-ctl --list-devices
Scegli il dispositivo giusto e avvia il programma:
VIDEO_DEVICE=/dev/videoX node index.js
