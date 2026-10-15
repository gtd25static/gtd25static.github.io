import { useCallback } from 'react';
import { CAPTURE_PROTOCOL } from '../../hooks/use-url-capture';

/** Drag-to-bookmark-bar link. React blocks javascript: hrefs, so set it via the DOM. */
function BookmarkletLink({ code, children }: { code: string; children: React.ReactNode }) {
  const ref = useCallback(
    (node: HTMLAnchorElement | null) => {
      if (node) node.setAttribute('href', code);
    },
    [code],
  );
  return (
    <a
      ref={ref}
      href="#"
      onClick={(e) => e.preventDefault()}
      draggable
      className="mt-2 inline-block cursor-grab rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-700"
    >
      {children}
    </a>
  );
}

export function ShareSettings() {
  const appUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const pageParams = "'title='+encodeURIComponent(document.title)+'&url='+encodeURIComponent(window.location.href)";
  // Opens a browser tab. Works without installing anything.
  const tabBookmarklet = `javascript:void(window.open('${appUrl}/?capture&'+${pageParams}))`;
  // Launches the INSTALLED app through the manifest's protocol handler. Assigning
  // a custom scheme to location.href hands it to the OS handler and leaves the
  // page you are capturing exactly where it is — unlike window.open, which
  // Chrome refuses to capture into an app because it opens an auxiliary context.
  const appBookmarklet = `javascript:void(window.location.href='${CAPTURE_PROTOCOL}capture?'+${pageParams})`;

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

        {/* Bookmarklets */}
        <div className="text-sm text-zinc-600 dark:text-zinc-400">
          <p className="font-medium text-zinc-700 dark:text-zinc-300">Desktop Bookmarklet</p>
          <p className="mt-1">
            Drag one to your bookmark bar. Click it on any page to capture the page
            title and URL to your inbox.
          </p>

          <div className="mt-2 space-y-3">
            <div>
              <BookmarkletLink code={appBookmarklet}>Capture to GTD25 (app)</BookmarkletLink>
              <p className="mt-1 text-xs">
                Saves to the installed app — in the window you already have open, if
                there is one. The first time, the browser asks whether to let this site
                open <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">{CAPTURE_PROTOCOL}</code>{' '}
                links — allow it. Needs the app installed. If clicking it does nothing,
                open the app once (the browser refreshes its link registration as it
                loads), then try again. In Paranoid Mode the app asks before adding
                a capture: any website you click a link on can send one.
              </p>
            </div>
            <div>
              <BookmarkletLink code={tabBookmarklet}>Capture to GTD25 (tab)</BookmarkletLink>
              <p className="mt-1 text-xs">
                Opens a normal browser tab. Works everywhere, installed or not.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
