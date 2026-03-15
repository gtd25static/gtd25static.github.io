export function ShareSettings() {
  const appUrl = typeof window !== 'undefined' ? window.location.origin : '';

  // Bookmarklet: captures current page title + URL, opens GTD app with capture params
  const bookmarkletCode = `javascript:void(window.open('${appUrl}/?capture&title='+encodeURIComponent(document.title)+'&url='+encodeURIComponent(window.location.href)))`;

  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
        Share to Inbox
      </h3>

      <div className="mt-3 space-y-4">
        {/* Web Share Target info */}
        <div className="text-sm text-zinc-600 dark:text-zinc-400">
          <p className="font-medium text-zinc-700 dark:text-zinc-300">Android Share</p>
          <p className="mt-1">
            Install this app to your home screen (Add to Home Screen), then share
            from any app — it will appear in the share sheet.
          </p>
        </div>

        {/* Bookmarklet */}
        <div className="text-sm text-zinc-600 dark:text-zinc-400">
          <p className="font-medium text-zinc-700 dark:text-zinc-300">Desktop Bookmarklet</p>
          <p className="mt-1">
            Drag this button to your bookmark bar. Click it on any page to capture
            the page title and URL to your inbox.
          </p>
          <a
            href={bookmarkletCode}
            onClick={(e) => e.preventDefault()}
            draggable
            className="mt-2 inline-block rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-700 cursor-grab"
          >
            Capture to GTD25
          </a>
        </div>
      </div>
    </div>
  );
}
