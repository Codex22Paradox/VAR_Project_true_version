const saveLastMinute = document.getElementById('saveLastMinute');
const stopRegistration = document.getElementById('stopRegistration');

const doFetch = async () => (await fetch("/save-last-minute")).json();

saveLastMinute.onclick = async () => console.log("pressione button... " + JSON.stringify(await doFetch()))

document.addEventListener('keydown', async (event) => {
    if (event.code === "Space") {
        event.preventDefault();
        console.log("pressione spazio.." + JSON.stringify(await doFetch()))
    }
    if (event.key === "1") {
        event.preventDefault();
        await stopVAR();
    }
})

async function stopVAR() {
    try {
        const response = await fetch("/cleanup-and-stop");
        const result = await response.json();
        console.log("Arresto VAR: " + JSON.stringify(result));
    } catch (error) {
        console.error("Errore durante l'arresto del VAR:", error);
    }
}

stopRegistration.onclick = stopVAR;