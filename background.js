// Background service worker

self.addEventListener('install', () => {
    console.log('Service Worker Installed');
});

self.addEventListener('activate', () => {
    console.log('Service Worker Activated');
});

self.addEventListener('message', (event) => {
    const { command, data } = event.data;
    switch (command) {
        case "saveSelection":
            saveSelection();
            break;
        case "saveWholePage":
            saveWholePage();
            break;
        case "saveTabs":
            saveTabs();
            break;
        case "saveCroppedScreenshot":
            getActiveTab().then(activeTab => saveCroppedScreenshot(activeTab.url));
            break;
        default:
            console.log("Unrecognized command", command);
    }
});

async function getActiveTab() {
    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    return tabs[0];
}

self.addEventListener('contextmenu', (event) => {
    createContextMenu();
});

function createContextMenu() {
    chrome.contextMenus.create({
        id: "trilium-save-selection",
        title: "Save selection to Trilium",
        contexts: ["selection"]
    });

    chrome.contextMenus.create({
        id: "trilium-save-cropped-screenshot",
        title: "Clip screenshot to Trilium",
        contexts: ["page"]
    });

    chrome.contextMenus.create({
        id: "trilium-save-cropped-screenshot",
        title: "Crop screen shot to Trilium",
        contexts: ["page"]
    });

    chrome.contextMenus.create({
        id: "trilium-save-whole-screenshot",
        title: "Save whole screen shot to Trilium",
        contexts: ["page"]
    });

    chrome.contextMenus.create({
        id: "trilium-save-page",
        title: "Save whole page to Trilium",
        contexts: ["page"]
    });

    chrome.contextMenus.create({
        id: "trilium-save-link",
        title: "Save link to Trilium",
        contexts: ["link"]
    });

    chrome.contextMenus.create({
        id: "trilium-save-image",
        title: "Save image to Trilium",
        contexts: ["image"]
    });

    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
        if (info.menuItemId === 'trilium-save-selection') {
            await saveSelection();
        } else if (info.menuItemId === 'trilium-save-cropped-screenshot') {
            await saveCroppedScreenshot(info.pageUrl);
        } else if (info.menuItemId === 'trilium-save-whole-screenshot') {
            await saveWholeScreenshot(info.pageUrl);
        } else if (info.menuItemId === 'trilium-save-image') {
            await saveImage(info.srcUrl, info.pageUrl);
        } else if (info.menuItemId === 'trilium-save-link') {
            const link = document.createElement("a");
            link.href = info.linkUrl;
            link.appendChild(document.createTextNode(info.linkText || info.linkUrl));

            const activeTab = await getActiveTab();

            const resp = await triliumServerFacade.callService('POST', 'clippings', {
                title: activeTab.title,
                content: link.outerHTML,
                pageUrl: info.pageUrl
            });

            if (!resp) {
                return;
            }

            toast("Link has been saved to Trilium.", resp.noteId);
        } else if (info.menuItemId === 'trilium-save-page') {
            await saveWholePage();
        } else {
            console.log("Unrecognized menuItemId", info.menuItemId);
        }
    });
}

function toast(message, noteId = null, tabIds = null) {
    getActiveTab().then(activeTab => {
        chrome.tabs.sendMessage(activeTab.id, {
            name: 'toast',
            message: message,
            noteId: noteId,
            tabIds: tabIds
        });
    });
}

async function saveSelection() {
    const payload = await sendMessageToActiveTab({ name: 'trilium-save-selection' });

    await postProcessImages(payload);

    const resp = await triliumServerFacade.callService('POST', 'clippings', payload);

    if (!resp) {
        return;
    }

    toast("Selection has been saved to Trilium.", resp.noteId);
}

async function saveCroppedScreenshot(pageUrl) {
    const cropRect = await sendMessageToActiveTab({ name: 'trilium-get-rectangle-for-screenshot' });

    const src = await takeCroppedScreenshot(cropRect);

    const payload = await getImagePayloadFromSrc(src, pageUrl);

    const resp = await triliumServerFacade.callService("POST", "clippings", payload);

    if (!resp) {
        return;
    }

    toast("Screenshot has been saved to Trilium.", resp.noteId);
}

async function saveWholeScreenshot(pageUrl) {
    const src = await takeWholeScreenshot();

    const payload = await getImagePayloadFromSrc(src, pageUrl);

    const resp = await triliumServerFacade.callService("POST", "clippings", payload);

    if (!resp) {
        return;
    }

    toast("Screenshot has been saved to Trilium.", resp.noteId);
}

async function saveWholePage() {
    const payload = await sendMessageToActiveTab({ name: 'trilium-save-page' });

    await postProcessImages(payload);

    const resp = await triliumServerFacade.callService('POST', 'notes', payload);

    if (!resp) {
        return;
    }

    toast("Page has been saved to Trilium.", resp.noteId);
}

async function sendMessageToActiveTab(message) {
    const activeTab = await getActiveTab();

    if (!activeTab) {
        throw new Error("No active tab.");
    }

    try {
        return await chrome.tabs.sendMessage(activeTab.id, message);
    } catch (e) {
        throw e;
    }
}

function blob2base64(blob) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onloadend = function () {
            resolve(reader.result);
        };
        reader.readAsDataURL(blob);
    });
}

async function postProcessImage(image) {
    if (image.src.startsWith("data:image/")) {
        image.dataUrl = image.src;
        image.src = "inline." + image.src.substr(11, 3); // this should extract file type - png/jpg
    } else {
        try {
            image.dataUrl = await fetchImage(image.src, image);
        } catch (e) {
            console.log(`Cannot fetch image from ${image.src}`);
        }
    }
}

async function postProcessImages(resp) {
    if (resp.images) {
        for (const image of resp.images) {
            await postProcessImage(image);
        }
    }
}

async function fetchImage(url) {
    const resp = await fetch(url);
    const blob = await resp.blob();

    return await blob2base64(blob);
}

function randomString(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
        counter += 1;
    }
    return result;
}

async function getImagePayloadFromSrc(src, pageUrl) {
    const image = {
        imageId: randomString(20),
        src: src
    };

    await postProcessImage(image);

    const activeTab = await getActiveTab();

    return {
        title: activeTab.title,
        content: `<img src="${image.imageId}">`,
        images: [image],
        pageUrl: pageUrl
    };
}

async function takeCroppedScreenshot(cropRect) {
    const activeTab = await getActiveTab();
    const zoom = await chrome.tabs.getZoom(activeTab.id) * window.devicePixelRatio;

    const newArea = Object.assign({}, cropRect);
    newArea.x *= zoom;
    newArea.y *= zoom;
    newArea.width *= zoom;
    newArea.height *= zoom;

    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    return await cropImage(newArea, dataUrl);
}

function cropImage(newArea, dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();

        img.onload = function () {
            const canvas = document.createElement('canvas');
            canvas.width = newArea.width;
            canvas.height = newArea.height;

            const ctx = canvas.getContext('2d');

            ctx.drawImage(img, newArea.x, newArea.y, newArea.width, newArea.height, 0, 0, newArea.width, newArea.height);

            resolve(canvas.toDataURL());
        };

        img.src = dataUrl;
    });
}

async function takeWholeScreenshot() {
    return await chrome.tabs.captureVisibleTab(null, { format: 'png' });
}
