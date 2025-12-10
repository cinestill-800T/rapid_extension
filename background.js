/**
 * Rapidgator Batch Downloader - Background Service Worker
 * 
 * Handles download monitoring and tab management.
 * This runs independently of the popup, ensuring reliability.
 */

// =============================================================================
// State Management
// =============================================================================

/**
 * Download state for each tab
 * @type {Map<number, {tabId: number, url: string, fileName: string, state: string, downloadId?: number, retryCount: number}>}
 */
const downloadStates = new Map();

// State constants
const STATE = {
    PENDING: 'pending',
    CLICKED: 'clicked',
    DOWNLOADING: 'downloading',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

// Configuration
const CONFIG = {
    DOWNLOAD_TIMEOUT_MS: 30000, // 30 seconds to detect download start
    MAX_RETRY_COUNT: 2,
    CHECK_INTERVAL_MS: 1000
};

// =============================================================================
// Message Handling (Communication with Popup)
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'startDownload':
            handleStartDownload(message.tab)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true; // Keep channel open for async response

        case 'getStates':
            sendResponse({ states: Array.from(downloadStates.values()) });
            return false;

        case 'retryFailed':
            handleRetryFailed(message.tabId)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'clearStates':
            downloadStates.clear();
            sendResponse({ success: true });
            return false;
    }
});

// =============================================================================
// Download Handling
// =============================================================================

/**
 * Start download process for a tab
 */
async function handleStartDownload(tab) {
    const { id: tabId, url } = tab;
    const fileName = extractFileName(url);

    // Initialize state
    downloadStates.set(tabId, {
        tabId,
        url,
        fileName: fileName || `Tab ${tabId}`,
        state: STATE.PENDING,
        retryCount: 0,
        startTime: Date.now()
    });

    try {
        // Click the download button
        await clickDownloadButton(tabId);

        // Update state to clicked
        updateState(tabId, STATE.CLICKED);

        // Start monitoring for download
        monitorDownloadStart(tabId, url);

        return { success: true, tabId };
    } catch (error) {
        updateState(tabId, STATE.FAILED, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Click download button on a tab
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
 * Monitor for download start after clicking button
 */
function monitorDownloadStart(tabId, originalUrl) {
    const state = downloadStates.get(tabId);
    if (!state) return;

    const checkTimeout = setTimeout(() => {
        // Timeout - download didn't start
        const currentState = downloadStates.get(tabId);
        if (currentState && currentState.state === STATE.CLICKED) {
            updateState(tabId, STATE.FAILED, 'ダウンロード開始のタイムアウト');
            notifyPopup('downloadFailed', { tabId, reason: 'timeout' });
        }
    }, CONFIG.DOWNLOAD_TIMEOUT_MS);

    // Store timeout reference for cleanup
    state.timeoutId = checkTimeout;
    downloadStates.set(tabId, state);
}

// =============================================================================
// Download Event Listeners
// =============================================================================

/**
 * Listen for new downloads
 */
chrome.downloads.onCreated.addListener((downloadItem) => {
    // Try to match this download to a pending tab
    const matchingEntry = findMatchingTab(downloadItem);

    if (matchingEntry) {
        const [tabId, state] = matchingEntry;

        // Clear timeout
        if (state.timeoutId) {
            clearTimeout(state.timeoutId);
        }

        // Update state
        state.downloadId = downloadItem.id;
        state.state = STATE.DOWNLOADING;
        downloadStates.set(tabId, state);

        console.log(`Download started for tab ${tabId}: ${downloadItem.filename || downloadItem.url}`);
        notifyPopup('downloadStarted', { tabId, downloadId: downloadItem.id });
    }
});

/**
 * Listen for download state changes
 */
chrome.downloads.onChanged.addListener((delta) => {
    // Find the tab associated with this download
    const matchingEntry = Array.from(downloadStates.entries())
        .find(([_, state]) => state.downloadId === delta.id);

    if (!matchingEntry) return;

    const [tabId, state] = matchingEntry;

    // Check if download started (state changed to in_progress)
    if (delta.state && delta.state.current === 'in_progress') {
        // Download confirmed - safe to close tab
        handleDownloadConfirmed(tabId);
    }

    // Check for completion
    if (delta.state && delta.state.current === 'complete') {
        updateState(tabId, STATE.COMPLETED);
        notifyPopup('downloadCompleted', { tabId });
    }

    // Check for interruption/error
    if (delta.error || (delta.state && delta.state.current === 'interrupted')) {
        updateState(tabId, STATE.FAILED, 'ダウンロードが中断されました');
        notifyPopup('downloadFailed', { tabId, reason: 'interrupted' });
    }
});

/**
 * Handle confirmed download - close the tab
 */
async function handleDownloadConfirmed(tabId) {
    const state = downloadStates.get(tabId);
    if (!state) return;

    try {
        // Small delay to ensure download is truly in progress
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Close the tab
        await chrome.tabs.remove(tabId);

        console.log(`Tab ${tabId} closed after download confirmed`);
        notifyPopup('tabClosed', { tabId });
    } catch (error) {
        console.warn(`Could not close tab ${tabId}:`, error.message);
        // Don't mark as failed - download is still working
    }
}

// =============================================================================
// Retry Handling
// =============================================================================

/**
 * Retry a failed download
 */
async function handleRetryFailed(tabId) {
    const state = downloadStates.get(tabId);
    if (!state || state.state !== STATE.FAILED) {
        return { success: false, error: '再試行対象が見つかりません' };
    }

    if (state.retryCount >= CONFIG.MAX_RETRY_COUNT) {
        return { success: false, error: '最大再試行回数に達しました' };
    }

    // Check if tab still exists
    try {
        await chrome.tabs.get(tabId);
    } catch {
        return { success: false, error: 'タブが既に閉じられています' };
    }

    state.retryCount++;
    state.state = STATE.PENDING;
    state.startTime = Date.now();
    downloadStates.set(tabId, state);

    return handleStartDownload({ id: tabId, url: state.url });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Extract filename from URL
 */
function extractFileName(url) {
    try {
        const urlObj = new URL(url);
        const parts = urlObj.pathname.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.includes('.')) {
            return decodeURIComponent(lastPart.replace('.html', ''));
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Find a tab that matches the download
 */
function findMatchingTab(downloadItem) {
    // 1. Try exact match by referrer (most reliable)
    if (downloadItem.referrer) {
        for (const [tabId, state] of downloadStates.entries()) {
            if (state.state !== STATE.CLICKED) continue;
            // Compare referrer with tab URL (ignore hash/params if needed, but exact is good start)
            if (downloadItem.referrer === state.url || state.url.startsWith(downloadItem.referrer)) {
                return [tabId, state];
            }
        }
    }

    // 2. Fallback: Match by URL similarity or queue order
    for (const [tabId, state] of downloadStates.entries()) {
        if (state.state !== STATE.CLICKED) continue;

        // Time-based matching: download started within reasonable time after click
        const timeSinceClick = Date.now() - state.startTime;
        if (timeSinceClick < CONFIG.DOWNLOAD_TIMEOUT_MS) {

            // If download URL looks like it came from Rapidgator
            const downloadUrl = downloadItem.url || downloadItem.finalUrl || '';
            const isRapidgatorDownload =
                downloadUrl.includes('rapidgator') ||
                downloadUrl.includes('rg.to') ||
                (downloadItem.referrer && downloadItem.referrer.includes('rapidgator'));

            if (isRapidgatorDownload) {
                // Return the oldest clicked tab (First-In-First-Out)
                return [tabId, state];
            }
        }
    }

    // 3. Last Resort: If we are aggressive, and we have only one pending tab, assume it's that one.
    // Useful if URL/Referrer are masked.
    const clickedTabs = Array.from(downloadStates.entries())
        .filter(([_, s]) => s.state === STATE.CLICKED);

    if (clickedTabs.length === 1) {
        return clickedTabs[0];
    }

    return null;
}

/**
 * Update state and notify popup
 */
function updateState(tabId, newState, error = null) {
    const state = downloadStates.get(tabId);
    if (state) {
        state.state = newState;
        if (error) state.error = error;
        downloadStates.set(tabId, state);
    }
}

/**
 * Notify popup of state changes
 */
function notifyPopup(event, data) {
    chrome.runtime.sendMessage({ event, ...data }).catch(() => {
        // Popup might be closed, that's OK
    });
}

// =============================================================================
// Initialization
// =============================================================================

console.log('Rapidgator Batch Downloader: Background service worker started');
