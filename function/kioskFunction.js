export const kioskFunction = {
    launchBrowserInKioskMode: (port) => {
        const url = `http://localhost:${port}`;
        let command;
        if (process.platform === 'win32') command = `start chrome --kiosk --app=${url} --start-fullscreen`; else if (process.platform === 'linux') command = `chromium-browser --kiosk ${url}`;
        exec(command, (error) => {
            if (error) {
                console.error('Errore avvio Chrome/Chromium, provo con Firefox:', error);
                if (process.platform === 'win32') command = `start firefox -kiosk ${url}`; else if (process.platform === 'linux') command = `firefox --kiosk ${url}`;
                exec(command, (error) => {
                    if (error) {
                        console.error('Errore anche con Firefox:', error);
                    }
                });
            }
        });
    },

    shutdownComputer: () => {
        return new Promise((resolve, reject) => {
            console.log('Iniziando lo spegnimento del sistema...');
            let command;

            if (process.platform === 'win32')
                command = 'shutdown /s /t 0';
            else if (process.platform === 'linux')
                command = 'systemctl poweroff';
            else
                return reject(new Error('Sistema operativo non supportato'));


            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error('Errore con il primo metodo di spegnimento:', error);
                    if (process.platform === 'linux') {
                        const alternateCommand = 'shutdown -h now';
                        exec(alternateCommand, (error2, stdout2, stderr2) => {
                            if (error2) {
                                console.error('Errore anche con shutdown:', error2);
                                exec('poweroff', (error3) => {
                                    if (error3) {
                                        return reject(new Error('Tutti i metodi di spegnimento hanno fallito'));
                                    }
                                    resolve('Comando poweroff eseguito');
                                });
                            } else {
                                resolve('Comando shutdown eseguito');
                            }
                        });
                    } else {
                        reject(error);
                    }
                } else {
                    resolve('Comando di spegnimento eseguito con successo');
                }
            });
        });
    }
};