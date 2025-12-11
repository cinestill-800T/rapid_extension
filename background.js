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

    // Step 1: Get the highest download ID currently in browser
    // New downloads will have IDs greater than this
    const allDownloads = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
    const maxIdBefore = allDownloads.length > 0 ? allDownloads[0].id : 0;
    console.log(`[BG] Max download ID before click: ${maxIdBefore}`);

    // Step 2: Click the download button
    try {
        await clickDownloadButton(tabId);
        console.log(`[BG] Clicked button on tab ${tabId}`);
    } catch (error) {
        console.error(`[BG] Failed to click button on tab ${tabId}:`, error);
        return { success: false, error: error.message, tabId };
    }

    // Step 3: Wait for a new download to appear (ID > maxIdBefore)
    try {
        const newDownload = await waitForNewDownload(maxIdBefore);
        console.log(`[BG] Download detected for tab ${tabId}: ID=${newDownload.id}`);

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
            // Strategy 1: Find the direct download link (premium accounts)
            // This is the actual file download link like: https://s64.rapidgator.net/download/...
            const directLink = document.querySelector('a[href*="rapidgator.net/download/"]');
            if (directLink) {
                console.log('[RG] Found direct download link:', directLink.href);
                // Navigate to the download link
                window.location.href = directLink.href;
                return { success: true, method: 'direct_link' };
            }

            // Strategy 2: Click the download button (may trigger JS)
            const downloadBtn = document.querySelector('.btn-download');
            if (downloadBtn) {
                console.log('[RG] Clicking .btn-download button');
                downloadBtn.click();
                return { success: true, method: 'btn_click' };
            }

            // Strategy 3: Look for any link that starts a download
            const anyDownloadLink = document.querySelector('a[href*="/download/"]');
            if (anyDownloadLink) {
                console.log('[RG] Found generic download link:', anyDownloadLink.href);
                window.location.href = anyDownloadLink.href;
                return { success: true, method: 'generic_link' };
            }

            return { success: false, error: 'ダウンロードリンクが見つかりません' };
        }
    });

    if (!results || !results[0]) {
        throw new Error('スクリプト実行に失敗しました');
    }

    const result = results[0].result;
    if (!result || !result.success) {
        throw new Error(result?.error || 'ダウンロードリンクが見つかりません');
    }

    console.log(`[BG] Download initiated via ${result.method}`);
}

/**
 * Wait for a new download to appear (download ID > maxIdBefore)
 */
function waitForNewDownload(maxIdBefore) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        const checkForNewDownload = async () => {
            // Check if we've exceeded timeout
            if (Date.now() - startTime > CONFIG.DOWNLOAD_TIMEOUT_MS) {
                reject(new Error('Timeout'));
                return;
            }

            // Query recent downloads
            const recentDownloads = await chrome.downloads.search({
                orderBy: ['-startTime'],
                limit: 10
            });

            // Find any download with ID greater than maxIdBefore
            const newDownload = recentDownloads.find(d =>
                d.id > maxIdBefore &&
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

console.log('[BG] Rapidgator Batch Downloader: Background service worker started (v3 - Fixed)');

