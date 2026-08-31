/**
 * Handing the player a file, in a page that runs in two very different
 * places.
 *
 * On the GitHub Pages build — which is what the phone actually plays — a
 * Blob URL on a synthetic `<a download>` is the right and only mechanism,
 * and it works.
 *
 * Inside a published Claude Artifact it does not. The viewer sandboxes the
 * page and never grants it permission to start a download, so the anchor is
 * inert: `a.click()` throws nothing and does nothing. That is what made the
 * previous version of this actively harmful rather than merely broken — the
 * click handler took its success branch and reported "Download started" for a
 * download that could never happen, on the one feature whose entire purpose is
 * getting a run out of browser storage before the browser throws it away.
 *
 * The Artifact runtime exposes a `downloads` capability for exactly this: the
 * page asks, the viewer gets a confirmation with the final filename and size,
 * and the file is saved only if they accept.
 *
 * So there are three cases, and the third is the one worth naming:
 *
 *   1. No `window.claude` at all — an ordinary page (GitHub Pages, a saved
 *      copy). Use the anchor. It works.
 *   2. `window.claude` present and the capability resolves — an Artifact
 *      viewer that granted it. Use `save()`.
 *   3. `window.claude` present but the capability resolves null — an Artifact
 *      context where the capability is not served or was not granted. Here the
 *      anchor is *also* dead, and falling back to it is precisely how the old
 *      code came to lie. Report unavailability instead, so the UI can point at
 *      "Copy run", which always works.
 *
 * Note this deliberately departs from the capability guidance's "null means
 * hide the affordance": that assumes a page which only ever runs as an
 * Artifact. Here null is the *normal* case, on the build the player uses most,
 * and the button works fine there.
 */
/** Whether we are running anywhere that could be an Artifact viewer. The
 * presence of `window.claude` is the only signal that separates case 3 from
 * case 1 — both have no working capability, but only one has a working
 * anchor. */
function inViewerContext() {
    return typeof window !== 'undefined' && typeof window.claude?.use === 'function';
}
/** Resolved once, at module load, and reused. The platform memoizes this
 * anyway, but holding the promise (rather than its result) is what lets a
 * click that lands during the resolve window still await it: the contract is
 * explicit that it never resolves during the first synchronous run and can
 * take up to 10 seconds when no viewer answers. */
const viewerDownloads = (async () => {
    if (!inViewerContext())
        return null;
    try {
        const ns = await window.claude.use('downloads');
        // Duck-typed rather than trusted: `use` is typed loosely here, and a
        // namespace without `save` would throw at the call site instead of being
        // caught as unavailability.
        return ns && typeof ns.save === 'function' ? ns : null;
    }
    catch {
        return null;
    }
})();
/** The plain-page path, unchanged from what shipped before the capability
 * existed — still correct everywhere `window.claude` is absent. */
function downloadViaAnchor(filename, text) {
    try {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        // Revoked on a later turn of the event loop: revoking synchronously can
        // invalidate the URL before the browser has started the download.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return { status: 'saved', via: 'anchor' };
    }
    catch (e) {
        return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
}
/** Turns the capability's error codes into something a player can act on.
 * Unknown codes are treated as unavailability, per the contract. */
function describeSaveError(err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
    switch (code) {
        case 'declined':
            return { status: 'declined' };
        case 'rate_limited':
            return { status: 'failed', message: 'A save prompt is already open — finish that one, then try again.' };
        case 'too_large':
            return { status: 'failed', message: 'This run is too big to save as a file here. Use "Copy run" instead.' };
        case 'rejected_extension':
        case 'extension_not_enabled':
            return { status: 'failed', message: 'This viewer will not save .json files. Use "Copy run" instead.' };
        case 'bad_request':
        case 'transform_error':
            return { status: 'failed', message: 'The run could not be packaged for saving. Use "Copy run" instead.' };
        default:
            return { status: 'failed', message: 'Saving files is not available here. Use "Copy run" instead.' };
    }
}
/**
 * Offers `text` to the player as `filename`, by whichever route this page
 * actually has. Never throws: every outcome, including the viewer simply
 * saying no, comes back as a value for the caller to report.
 */
export async function offerRunDownload(filename, text) {
    const downloads = await viewerDownloads;
    if (downloads) {
        try {
            await downloads.save({ filename, data: text });
            return { status: 'saved', via: 'viewer' };
        }
        catch (e) {
            return describeSaveError(e);
        }
    }
    if (inViewerContext()) {
        // Case 3. The anchor cannot work here, so do not pretend it might.
        return { status: 'failed', message: 'Saving files is not available here. Use "Copy run" instead.' };
    }
    return downloadViaAnchor(filename, text);
}
