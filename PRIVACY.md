# Privacy

VEYL processes files locally and connects to the AI provider you select. It has no app-operated account service, analytics endpoint or automatic update service.

## What goes to a provider

- Your current request, relevant conversation context and app-provided filenames/paths/metadata needed for a scoped task.
- Selected safe text only when **Include selected text** is authorized for that turn. Text you type directly is also request content.
- Bounded sanitized image pixels when you explicitly ask to view/describe images or rename from their contents. Names-only/no-share directions override this. A filename/selection narrows the set; a current-folder request can include the complete bounded immediate set.
- Normalized file-type identifiers/category for automatic icon design. No filename, path or file contents are included in that background request. Disable the type designer permission to stop new designs.

Providers handle these inputs under their own account, privacy and retention terms. OpenAI API requests use `store:false`; this does not override all vendor retention policies. Clearing local chat does not delete provider-side data. CLI subscriptions and API accounts are separate.

## Local state and credentials

Existing chat, settings and icon cache use `~/.config/systemus`, retained for compatibility. User conversations may contain sensitive information they typed. Clear chat removes the local transcript; uninstalling the package preserves user state and CLI authentication. Undo originals are bounded session memory, not a persistent backup.

Keys entered in Settings are namespaced by agent and API vendor. Plaintext keys never return to the renderer or go into the settings file. Persistent key encryption requires a supported real OS secret backend; insecure Linux `basic_text`, locked or unavailable storage uses session-only access and retains existing ciphertext. No environment/global API keys are imported, and no OAuth token is extracted or rewritten.

Private model scratch directories and staged image attachments are removed after completion/failure/cancellation. OS file clipboard integration imports supported local file URLs only; general clipboard contents are not supplied to the assistant. Development verification restores clipboard state and should use an isolated display where possible.

## Limits of protection

Agent sharing/actions exclude hidden directories/ancestors, credential files and the app's own state, including sensitive aliases and unfamiliar hidden configuration stores. Ordinary hidden regular files are available with authorized hidden visibility; credential dotfiles remain excluded. Agent archive extraction uses member types to apply the same hidden-directory/credential boundary; manual explorer access remains available. Configured keys and common token patterns are redacted from new provider prompts/results/errors. These are targeted safeguards, not comprehensive secret detection. They do not retroactively erase older user messages. Review what you choose to share and avoid pasting secrets.

File/model outputs and image text are untrusted evidence. They cannot grant scope, override permissions or invoke arbitrary shell/tools. Manual explorer access remains controlled by you and your normal OS permissions.
