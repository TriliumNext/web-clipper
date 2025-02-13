// Import required utilities
importScripts('utils.js', 'trilium_server_facade.js');

// Service worker activation
self.addEventListener('activate', event => {
	console.log('Service worker activated');
	// Claim control immediately
	event.waitUntil(clients.claim());
});

// Service worker installation
self.addEventListener('install', event => {
	console.log('Service worker installed');
	// Skip waiting immediately
	event.waitUntil(self.skipWaiting());
});

// Keyboard shortcuts
chrome.commands.onCommand.addListener(async function (command) {
	if (command == "saveSelection") {
		await saveSelection();
	} else if (command == "saveWholePage") {
		await saveWholePage();
	} else if (command == "saveTabs") {
		await saveTabs();
	} else if (command == "saveCroppedScreenshot") {
		const activeTab = await getActiveTab();
		await saveCroppedScreenshot(activeTab.url);
	} else {
		console.log("Unrecognized command", command);
	}
});

function cropImage(newArea, dataUrl) {
	return new Promise((resolve, reject) => {
		// Create an image bitmap first
		fetch(dataUrl)
			.then(response => response.blob())
			.then(blob => createImageBitmap(blob))
			.then(imageBitmap => {
				const canvas = new OffscreenCanvas(newArea.width, newArea.height);
				const ctx = canvas.getContext('2d');
				
				ctx.drawImage(imageBitmap, newArea.x, newArea.y, newArea.width, newArea.height, 0, 0, newArea.width, newArea.height);
				
				return canvas.convertToBlob();
			})
			.then(blob => {
				const reader = new FileReader();
				reader.onloadend = () => resolve(reader.result);
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			})
			.catch(reject);
	});
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

async function takeWholeScreenshot() {
	return await chrome.tabs.captureVisibleTab(null, { format: 'png' });
}

// Context menu setup
chrome.runtime.onInstalled.addListener(() => {
	if (isDevEnv()) {
		chrome.action.setIcon({
			path: 'icons/32-dev.png',
		});
	}

	// Create context menu items
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
});

async function getActiveTab() {
	const [tab] = await chrome.tabs.query({
		active: true,
		currentWindow: true
	});
	return tab;
}

async function getWindowTabs() {
	return await chrome.tabs.query({
		currentWindow: true
	});
}

async function sendMessageToActiveTab(message) {
	const activeTab = await getActiveTab();

	if (!activeTab) {
		throw new Error("No active tab.");
	}

	try {
		return await chrome.tabs.sendMessage(activeTab.id, message);
	}
	catch (e) {
		throw e;
	}
}

function toast(message, noteId = null, tabIds = null) {
	sendMessageToActiveTab({
		name: 'toast',
		message: message,
		noteId: noteId,
		tabIds: tabIds
	});
}

function blob2base64(blob) {
	return new Promise(resolve => {
		const reader = new FileReader();
		reader.onloadend = function() {
			resolve(reader.result);
		};
		reader.readAsDataURL(blob);
	});
}

async function fetchImage(url) {
	const resp = await fetch(url);
	const blob = await resp.blob();

	return await blob2base64(blob);
}

async function postProcessImage(image) {
	if (image.src.startsWith("data:image/")) {
		image.dataUrl = image.src;
		image.src = "inline." + image.src.substr(11, 3); // this should extract file type - png/jpg
	}
	else {
		try {
			image.dataUrl = await fetchImage(image.src, image);
		}
		catch (e) {
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

async function saveSelection() {
	const payload = await sendMessageToActiveTab({name: 'trilium-save-selection'});

	await postProcessImages(payload);

	const resp = await triliumServerFacade.callService('POST', 'clippings', payload);

	if (!resp) {
		return;
	}

	toast("Selection has been saved to Trilium.", resp.noteId);
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

async function saveCroppedScreenshot(pageUrl) {
	const cropRect = await sendMessageToActiveTab({name: 'trilium-get-rectangle-for-screenshot'});

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

async function saveImage(srcUrl, pageUrl) {
	const payload = await getImagePayloadFromSrc(srcUrl, pageUrl);

	const resp = await triliumServerFacade.callService("POST", "clippings", payload);

	if (!resp) {
		return;
	}

	toast("Image has been saved to Trilium.", resp.noteId);
}

async function saveWholePage() {
	const payload = await sendMessageToActiveTab({name: 'trilium-save-page'});

	await postProcessImages(payload);

	const resp = await triliumServerFacade.callService('POST', 'notes', payload);

	if (!resp) {
		return;
	}

	toast("Page has been saved to Trilium.", resp.noteId);
}

async function saveLinkWithNote(title, content) {
	const activeTab = await getActiveTab();

	if (!title.trim()) {
		title = activeTab.title;
	}

	const resp = await triliumServerFacade.callService('POST', 'notes', {
		title: title,
		content: content,
		clipType: 'note',
		pageUrl: activeTab.url
	});

	if (!resp) {
		return false;
	}

	toast("Link with note has been saved to Trilium.", resp.noteId);

	return true;
}

async function getTabsPayload(tabs) {
	let content = '<ul>';
	tabs.forEach(tab => {
		content += `<li><a href="${tab.url}">${tab.title}</a></li>`
	});
	content += '</ul>';

	const domainsCount = tabs.map(tab => tab.url)
		.reduce((acc, url) => {
			const hostname = new URL(url).hostname
			return acc.set(hostname, (acc.get(hostname) || 0) + 1)
		}, new Map());

	let topDomains = [...domainsCount]
		.sort((a, b) => {return b[1]-a[1]})
		.slice(0,3)
		.map(domain=>domain[0])
		.join(', ')

	if (tabs.length > 3) { topDomains += '...' }

	return {
		title: `${tabs.length} browser tabs: ${topDomains}`,
		content: content,
		clipType: 'tabs'
	};
}

async function saveTabs() {
	const tabs = await getWindowTabs();

	const payload = await getTabsPayload(tabs);

	const resp = await triliumServerFacade.callService('POST', 'notes', payload);

	if (!resp) {
		return;
	}

	const tabIds = tabs.map(tab=>{return tab.id});

	toast(`${tabs.length} links have been saved to Trilium.`, resp.noteId, tabIds);
}

chrome.contextMenus.onClicked.addListener(async function(info, tab) {
	if (info.menuItemId === 'trilium-save-selection') {
		await saveSelection();
	}
	else if (info.menuItemId === 'trilium-save-cropped-screenshot') {
		await saveCroppedScreenshot(info.pageUrl);
	}
	else if (info.menuItemId === 'trilium-save-whole-screenshot') {
		await saveWholeScreenshot(info.pageUrl);
	}
	else if (info.menuItemId === 'trilium-save-image') {
		await saveImage(info.srcUrl, info.pageUrl);
	}
	else if (info.menuItemId === 'trilium-save-link') {
		const linkHtml = `<a href="${info.linkUrl}">${info.linkText || info.linkUrl}</a>`;
		const activeTab = await getActiveTab();

		const resp = await triliumServerFacade.callService('POST', 'clippings', {
			title: activeTab.title,
			content: linkHtml,
			pageUrl: info.pageUrl
		});

		if (!resp) {
			return;
		}

		toast("Link has been saved to Trilium.", resp.noteId);
	}
	else if (info.menuItemId === 'trilium-save-page') {
		await saveWholePage();
	}
	else {
		console.log("Unrecognized menuItemId", info.menuItemId);
	}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	console.log("Received", request);

	const handleMessage = async () => {
		let response;
		
		try {
			if (request.name === 'openNoteInTrilium') {
				const resp = await triliumServerFacade.callService('POST', 'open/' + request.noteId);

				if (resp && resp.result === 'open-in-browser') {
					const {triliumServerUrl} = await chrome.storage.sync.get("triliumServerUrl");

					if (triliumServerUrl) {
						const noteUrl = triliumServerUrl + '/#' + request.noteId;
						console.log("Opening new tab in browser", noteUrl);
						await chrome.tabs.create({ url: noteUrl });
					} else {
						console.error("triliumServerUrl not found in local storage.");
					}
				}
				response = resp;
			}
			else if (request.name === 'closeTabs') {
				response = await chrome.tabs.remove(request.tabIds);
			}
			else if (request.name === 'load-script') {
				response = await chrome.scripting.executeScript({
					target: { tabId: sender.tab.id },
					files: [request.file]
				});
			}
			else if (request.name === 'save-cropped-screenshot') {
				const activeTab = await getActiveTab();
				response = await saveCroppedScreenshot(activeTab.url);
			}
			else if (request.name === 'save-whole-screenshot') {
				const activeTab = await getActiveTab();
				response = await saveWholeScreenshot(activeTab.url);
			}
			else if (request.name === 'save-whole-page') {
				response = await saveWholePage();
			}
			else if (request.name === 'save-link-with-note') {
				response = await saveLinkWithNote(request.title, request.content);
			}
			else if (request.name === 'save-tabs') {
				response = await saveTabs();
			}
			else if (request.name === 'trigger-trilium-search') {
				response = await triliumServerFacade.triggerSearchForTrilium();
			}
			else if (request.name === 'send-trilium-search-status') {
				response = await triliumServerFacade.sendTriliumSearchStatusToPopup();
			}
			else if (request.name === 'trigger-trilium-search-note-url') {
				const activeTab = await getActiveTab();
				response = await triliumServerFacade.triggerSearchNoteByUrl(activeTab.url);
			}
			
			sendResponse({ success: true, data: response });
		} catch (error) {
			console.error('Error handling message:', error);
			sendResponse({ success: false, error: error.message });
		}
	};

	handleMessage().catch(error => {
		console.error('Error in message handler:', error);
		sendResponse({ success: false, error: error.message });
	});

	return true; // Indicates we'll respond asynchronously
});
