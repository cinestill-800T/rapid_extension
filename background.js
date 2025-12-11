/**
 * Rapidgator Batch Downloader - Background Service Worker
 *
 * Simplified approach:
 * 1. Click button on tab
 * 2. Poll for new download within timeout
 * 3. When download detected, close tab immediately
 * 4. Report result back to popup
 */

// Configuration
const CONFIG = {
    DOWNLOAD_TIMEOUT_MS: 30000,  // 30 seconds max wait for download to start
    POLL_INTERVAL_MS: 500        // Check every 500ms
};

// Track active processing
const processingTabs = new Map(); // tabId -> { resolve, reject, timeoutId }

// =============================================================================
// Message Handling
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'processTab':
            processTab(message.tab)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true; // Keep channel open for async response

        case 'ping':
            sendResponse({ alive: true });
            return false;
    }
});

// =============================================================================
// Main Processing Logic
// =============================================================================

/**
 * Process a single tab: click button, wait for download, close tab
 * Returns a promise that resolves when download starts (not just button click)
 */
async function processTab(tab) {
    const { id: tabId } = tab;
    console.log(`[BG] Processing tab ${tabId}`);

    // Step 1: Get current download count to detect new downloads
    const downloadsBefore = await chrome.downloads.search({ state: 'in_progress' });
    const downloadIdsBefore = new Set(downloadsBefore.map(d => d.id));

    // Step 2: Click the download button
    try {
        await clickDownloadButton(tabId);
        console.log(`[BG] Clicked button on tab ${tabId}`);
    } catch (error) {
        console.error(`[BG] Failed to click button on tab ${tabId}:`, error);
        return { success: false, error: error.message, tabId };
    }

    // Step 3: Wait for a new download to appear
    try {
        const newDownload = await waitForNewDownload(downloadIdsBefore);
        console.log(`[BG] Download detected for tab ${tabId}:`, newDownload.id);

        // Step 4: Close the tab
        try {
            await chrome.tabs.remove(tabId);
            console.log(`[BG] Tab ${tabId} closed successfully`);
        } catch (closeError) {
            console.warn(`[BG] Could not close tab ${tabId}:`, closeError.message);
            // Download started, so this is still a success
        }

        return { success: true, tabId, downloadId: newDownload.id };
    } catch (error) {
        console.error(`[BG] Timeout waiting for download on tab ${tabId}`);
        return { success: false, error: 'ダウンロード開始のタイムアウト', tabId };
    }
}

/**
 * Click the download button on a tab
 */
async function clickDownloadButton(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            const downloadBtn = document.querySelector('.btn-download');
            if (!downloadBtn) {
                throw new Error('ダウンロードボタンが見つかりません');
            }
            downloadBtn.click();
            return true;
        }
    });

    if (!results || !results[0] || !results[0].result) {
        throw new Error('スクリプト実行に失敗しました');
    }
}

/**
 * Wait for a new download to appear (polling approach)
 */
function waitForNewDownload(existingIds) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        const checkForNewDownload = async () => {
            // Check if we've exceeded timeout
            if (Date.now() - startTime > CONFIG.DOWNLOAD_TIMEOUT_MS) {
                reject(new Error('Timeout'));
                return;
            }

            // Query all current downloads
            const currentDownloads = await chrome.downloads.search({});

            // Find any new download (not in existingIds)
            const newDownload = currentDownloads.find(d =>
                !existingIds.has(d.id) &&
                (d.state === 'in_progress' || d.state === 'complete')
            );

            if (newDownload) {
                resolve(newDownload);
            } else {
                // Keep polling
                setTimeout(checkForNewDownload, CONFIG.POLL_INTERVAL_MS);
            }
        };

        // Start polling
        checkForNewDownload();
    });
}

// =============================================================================
// Initialization
// =============================================================================

console.log('[BG] Rapidgator Batch Downloader: Background service worker started (v2 - Simplified)');
