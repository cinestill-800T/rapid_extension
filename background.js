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
/**
 * Process a single tab: click button, wait for download, close tab
 * Returns a promise that resolves when download starts (not just button click)
 */
async function processTab(tab) {
    const { id: tabId, url } = tab;
    console.log(`[BG] Processing tab ${tabId} : ${url}`);

    // Extract expected filename from URL for matching
    // URL format: https://rapidgator.net/file/xxxx/Filename.ext.html
    let expectedFilename = null;
    try {
        const urlObj = new URL(url);
        const parts = urlObj.pathname.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart) {
            expectedFilename = decodeURIComponent(lastPart.replace('.html', ''));
        }
    } catch (e) {
        console.warn(`[BG] Failed to extract filename from ${url}`, e);
    }
    console.log(`[BG] Tab ${tabId} expects filename: ${expectedFilename}`);

    // Step 1: Get the highest download ID currently in browser
    const allDownloads = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
    const maxIdBefore = allDownloads.length > 0 ? allDownloads[0].id : 0;

    // Step 2: Click the download button
    let clickedLinkUrl = null;
    try {
        const result = await clickDownloadButton(tabId);
        if (result && result.clickedUrl) {
            clickedLinkUrl = result.clickedUrl;
            console.log(`[BG] Tab ${tabId} clicked direct link: ${clickedLinkUrl}`);
        }
    } catch (error) {
        console.error(`[BG] Failed to click button on tab ${tabId}:`, error);
        return { success: false, error: error.message, tabId };
    }

    // Step 3: Wait for a MATCHING new download to appear
    try {
        const newDownload = await waitForMatchingDownload(maxIdBefore, expectedFilename, clickedLinkUrl);
        console.log(`[BG] Download confirmed for tab ${tabId}: ID=${newDownload.id} Name=${newDownload.filename}`);

        // Step 4: Close the tab
        try {
            await chrome.tabs.remove(tabId);
            console.log(`[BG] Tab ${tabId} closed successfully`);
        } catch (closeError) {
            console.warn(`[BG] Could not close tab ${tabId}:`, closeError.message);
        }

        return { success: true, tabId, downloadId: newDownload.id };
    } catch (error) {
        console.error(`[BG] Timeout waiting for download on tab ${tabId}`);
        return { success: false, error: 'ダウンロード開始のタイムアウト (一致するファイルが見つかりません)', tabId };
    }
}

/**
 * Click the download button on a tab
 */
async function clickDownloadButton(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            // Strategy 1: Find direct link
            const directLink = document.querySelector('a[href*="rapidgator.net/download/"]');
            if (directLink) {
                // Click direct link
                directLink.click();
                return { success: true, method: 'direct_link', clickedUrl: directLink.href };
            }

            // Strategy 2: Click .btn-download
            const downloadBtn = document.querySelector('.btn-download');
            if (downloadBtn) {
                downloadBtn.click();
                return { success: true, method: 'btn_click', clickedUrl: null };
            }

            // Strategy 3: Generic download link
            const anyDownloadLink = document.querySelector('a[href*="/download/"]');
            if (anyDownloadLink) {
                anyDownloadLink.click();
                return { success: true, method: 'generic_link', clickedUrl: anyDownloadLink.href };
            }

            return { success: false, error: 'ダウンロードリンクが見つかりません' };
        }
    });

    if (!results || !results[0] || !results[0].result || !results[0].result.success) {
        const msg = results?.[0]?.result?.error || 'スクリプト実行失敗';
        throw new Error(msg);
    }

    return results[0].result;
}

/**
 * Wait for a new download that MATCHES the tab's content
 */
function waitForMatchingDownload(maxIdBefore, expectedFilename, expectedUrl) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        const checkLoop = async () => {
            if (Date.now() - startTime > CONFIG.DOWNLOAD_TIMEOUT_MS) {
                reject(new Error('Timeout'));
                return;
            }

            // Get recent downloads newer than our snapshot
            const recent = await chrome.downloads.search({
                orderBy: ['-startTime'],
                limit: 10
            });

            // Filter for NEW downloads
            const newDownloads = recent.filter(d =>
                d.id > maxIdBefore &&
                (d.state === 'in_progress' || d.state === 'complete')
            );

            // Look for a match
            const match = newDownloads.find(d => {
                // Check 1: Exact URL match (strongest signal)
                if (expectedUrl && d.url === expectedUrl) return true;
                if (expectedUrl && d.finalUrl === expectedUrl) return true;

                // Check 2: Filename inclusion (robust signal)
                if (expectedFilename && d.filename && d.filename.includes(expectedFilename)) return true;

                // Fallback: If we have no info, we can't safely match in concurrent mode
                // But for Rapidgator, we almost always have expectedFilename from tab URL.
                return false;
            });

            if (match) {
                resolve(match);
            } else {
                setTimeout(checkLoop, CONFIG.POLL_INTERVAL_MS);
            }
        };

        checkLoop();
    });
}

// =============================================================================
// Initialization
// =============================================================================

console.log('[BG] Rapidgator Batch Downloader: Background service worker started (v3 - Fixed)');

