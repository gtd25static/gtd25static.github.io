// Shown in place of the app while the vault is being re-keyed: the content
// tables are swapped under a new key in one transaction, and a mounted app would
// re-query the new rows with the old key for a moment and quarantine them.
export function VaultBusyScreen() {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-100 p-4 dark:bg-zinc-950">
      <div
        role="status"
        aria-live="polite"
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="mb-2 flex items-center gap-2">
          <span aria-hidden className="text-xl">🔑</span>
          <h1 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">Re-keying this device</h1>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Encrypting your data under a new key. Keep this tab open.
        </p>
      </div>
    </div>
  );
}
