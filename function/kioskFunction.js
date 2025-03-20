import {exec} from "child_process";

export const kioskFunction = {
    launchBrowserInKioskMode: (port) => {
        const url = `http://localhost:${port}`;
        let command;
        if (process.platform === 'win32')
            command = `start chrome --kiosk --app=${url} --start-fullscreen`;
        else if (process.platform === 'linux')
            command = `chromium-browser --kiosk ${url}`;
        exec(command, (error) => {
                if (error) {
                    console.error('Errore avvio Chrome/Chromium, provo con Firefox:', error);
                    if (process.platform === 'win32')
                        command = `start firefox -kiosk ${url}`;
                    else if (process.platform === 'linux')
                        command = `firefox --kiosk ${url}`;
                    exec(command, (error) => {
                        if (error) {
                            console.error('Errore anche con Firefox:', error);
                        }
                    });
                }
            }
        );
    }
}