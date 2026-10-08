# Subtable

A Chrome **Manifest V3** extension that uses a creator’s existing browser login to import Patreon and Boosty subscribers into one browsable table, then downloads a combined CSV. No API key, OAuth application, backend, build step, or runtime dependencies.

**This project is AI-generated.**

## Install

1. Open `chrome://extensions` in Chrome (106 or newer).
2. Turn on **Developer mode** and choose **Load unpacked**.
3. Select the [`extension`](extension/) directory in this project.
4. Pin **Subtable — Subscriber CSV Export** to the toolbar.

For the packaged version, unzip `dist/subtable-1.1.0.zip` and load the extracted folder. The manifest must be at the root of the folder you select. Chrome does not install a local ZIP directly.

## Import and download

1. Sign in to **your creator account** on Patreon or Boosty in the same browser profile.
2. Open **Audience / Relationship Manager** on Patreon, or **Statistics → Subscribers** on your Boosty blog. Allow the page’s subscriber list to load.
3. Click the extension toolbar button. Subtable opens a dedicated tab so imports can continue when you switch browser tabs.
4. Select the source tab and click **Connect to this tab**. Confirm the detected Patreon campaign ID or Boosty blog name. You can enter it manually if necessary.
5. Choose the audience, then click **Import subscribers**. Keep both the source tab and Subtable tab open. Importing adds records to your collection without downloading a file.
6. Select and connect another Patreon or Boosty tab, then import again to add its subscribers to the same collection. Click the refresh button if you opened a new source tab.
7. Browse the table with search, the source filter, sortable column headings, and pagination. **Details** shows every field for a subscriber.
8. Choose the CSV separator and UTF-8 setting, then click **Download combined CSV** and choose where to save it.

Every row identifies its source, such as `Patreon · 1234567` or `Boosty · your-blog`. Re-importing the same source updates matching subscriber IDs and adds new ones. Rows absent from a later import stay in the collection, including when you import a narrower Patreon filter. Subscriber IDs are scoped to the platform and creator; the same person on different sources remains a separate row for each source, even if the email matches.

**Downloads always include the entire imported collection.** Search, source filters, and pagination only affect browsing. Downloading uses a snapshot of the collection without making platform requests, so an import completed while the Save As dialog is open does not change that CSV. Download again to include the new rows.

Switching sources and failed or cancelled imports keep your existing collection. **Clear all data** asks for confirmation and removes the entire in-memory collection. Closing or reloading the Subtable tab also discards it; the browser is asked to warn before leaving with unsaved rows or an operation in progress. Download a CSV to keep a copy.

Patreon defaults to all member statuses. **Current Patreon Audience filters** reuses the member request observed when you connected (including filters/search). Change filters in Patreon and reconnect to capture a new selection. A passive observer starts when a Patreon page loads and keeps the latest Audience request URL, so detection continues even after the browser’s resource timing history fills up. If the observer is missing or has not seen an Audience request, **Current Patreon Audience filters** is disabled; refresh the Audience page, wait for its list to load, and reconnect. All-members import remains available with a detected or manually entered campaign ID. A manual campaign ID uses a built-in session endpoint request. Boosty imports all statuses returned by its subscriber endpoint, including inactive subscriptions. This imports subscribers **to your creator page**, not the creators you subscribe to.

## CSV format

CSV files use quoted cells, CRLF line endings, and optional UTF-8 BOM (enabled by default for Excel). Choose semicolons for spreadsheet locales that expect them. Formula-like strings receive a leading apostrophe to prevent spreadsheet formula execution. The files have these 18 columns:

| Column | Meaning |
| --- | --- |
| `source` | Human-readable platform and creator, matching the table’s Source column |
| `platform`, `creator` | Source platform and campaign ID / blog name |
| `subscriber_id`, `user_id` | Membership ID and user ID; Boosty uses the user ID for both |
| `name`, `email` | Identity fields available to the creator |
| `status`, `tier` | Platform’s membership status and tier names; multiple Patreon tiers use ` \| ` |
| `amount`, `currency` | Current entitled/pledged amount on Patreon; subscription price on Boosty; available currency code |
| `lifetime_amount` | Campaign lifetime support on Patreon; total payments on Boosty |
| `joined_at` | Membership start |
| `last_payment_at`, `last_payment_status` | Last attempted charge on Patreon, when available |
| `next_payment_at`, `ended_at` | Next payment and subscription end, when available |
| `profile_url` | User profile URL, when provided by Patreon |

Amounts use major currency units: Patreon cents are divided by 100; Boosty’s website prices are already in major units. There is no currency conversion. Currency stays blank if it cannot be determined. Dates are normalized to ISO 8601 UTC where parseable. Missing, withheld, or unrequested fields remain blank; zero is preserved as zero. Boosty’s subscriber list does not provide all Patreon payment fields.

## Session access and privacy

- Requests run on demand in an extension-isolated script inside the selected platform tab. Patreon requests use its existing cookies. Boosty requests read only its named `auth` cookie / `auth` or `token` local-storage entry and send the access token directly to `api.boosty.to`. Tokens never enter extension messages, files, or extension storage. No token refresh or cookie modification is performed.
- Only allowlisted read-only subscriber and current-user endpoints can be requested. Redirects are rejected, and Patreon pagination links cannot switch origin, endpoint, or campaign.
- Subscriber records stay in the export tab’s memory until cleared or closed. There is no analytics, server upload, persistent data cache, or broad cookie permission. A passive content script runs only on Patreon pages, in the extension’s isolated world. It retains one Audience request URL in page memory; it does not read response bodies, send requests, or change the website’s timing buffer. Downloaded CSVs remain on your device until you delete them.
- Permissions: `scripting` reads the selected source page; exact Patreon/Boosty website host permissions allow session access and discovery of their tabs; `downloads` saves your CSV and reports completion. There is no permission to read unrelated websites.
- Long-running pagination lives in the export tab, so MV3 service-worker suspension does not interrupt it. Requests have a 20-second timeout, a delay between pages, bounded 429/5xx retries, and cancellation. Closing or navigating the source tab requires reconnecting.
- Each source import is checked completely before it is merged into the collection. Repeated pages/cursors, changing totals, malformed responses, mid-import failures, and mismatches with a reported total stop the import without changing existing rows. Unknown totals rely on the platform’s pagination behavior. Importing a truly empty audience allows a header-only CSV if the collection is otherwise empty. Limits: 10,000 pages per import and 1,000,000 rows in the combined collection.

## Platform compatibility

**These integrations use internal website endpoints.** They can change independently of the extension. A logged-in creator account with permission to view that audience is required; the extension cannot reveal hidden fields or bypass a verification page.

- Patreon: `/api/members` (or an observed `/api/campaigns/{id}/members` request), with cookies from the selected tab. Uses the Audience page’s actual request fields/includes when detected, preserving server-side field availability. This is distinct from the [documented OAuth API](https://docs.patreon.com/), which requires OAuth credentials. The session endpoint is also described in a [firsthand Patreon developer discussion](https://www.patreondevelopers.com/t/check-if-user-is-subscribed-to-campaign-w-o-login/3856). Patreon offers its own [Audience CSV export](https://support.patreon.com/hc/en-gb/articles/34784011795469-Exporting-your-audience-s-emails-from-Patreon) if an internal endpoint changes.
- Boosty: `GET /v1/user/current` and `GET /v1/blog/{blog}/subscribers`, with offset pagination. The endpoint, session cookie format, status values, price units, and pagination parameters were checked against the [current Boosty web application](https://boosty.to/) JavaScript on 2026-10-07 (`app.HUSld7Vh.js` and `index.UvqZVJ-W.js`).

Validation includes automated contract/security tests and a real Chromium MV3 smoke test with synthetic HTTP responses. **Live authenticated imports have not been verified against creator accounts.** Before relying on a production CSV, compare each source’s row count and sample fields with your platform’s subscriber view. An error is displayed for expired sessions, unavailable creator access, verification pages, and incompatible responses; reconnect after resolving the issue on the source site.

## Development and tests

Node.js 20+ is needed only for development checks. No `npm install` is required.

```sh
npm test
npm run check
npm run package
```

`npm run package` creates `dist/subtable-<version>.zip` with extension files only and requires the system `zip` utility. The version comes from `extension/manifest.json` and must match `package.json`. Packaging tests also require `unzip` (available on GitHub’s Ubuntu runners) and never publish anything. After editing extension files, click **Reload** on `chrome://extensions` and reopen the export tab. Also refresh open Patreon pages so the Audience observer starts with the page.

The optional browser smoke test uses a temporary, disposable profile and synthetic intercepted responses. It does not use your logged-in profile. It verifies MV3 loading, real `chrome.scripting` session requests, imports from multiple creators across both platforms, re-imports, source labels, table search/sorting/pagination/details, combined CSV downloads, clear confirmation, and responsive layout. Regression checks cover Patreon filter detection after timing-buffer overflow, safe handling of a missing observer, download snapshots during later imports, and preservation of the collection after an import fails or is cancelled. Screenshots are written to ignored `test-results/`.

```sh
CHROME_BIN="/path/to/chromium-or-chrome-for-testing" node tests/browser-smoke.mjs
```

Use a Chromium build that supports `--load-extension` (for example, Chrome for Testing or Brave). Some branded Chrome builds restrict command-line extension loading; manual **Load unpacked** remains the installation path.

## GitHub CI and releases

[The GitHub Actions workflow](.github/workflows/ci.yml) runs tests, validates the extension, and packages a ZIP on pull requests and branch pushes. Download the ZIP from the run’s `extension-<version>` artifact (retained for 14 days). The optional browser smoke test remains a local check.

To publish a GitHub Release:

1. Set the same `X.Y.Z` version in `extension/manifest.json` and `package.json`, then commit and push the changes to your GitHub repository.
2. Create and push the matching `vX.Y.Z` tag, for example:

   ```sh
   git tag -a v1.1.0 -m "Release v1.1.0"
   git push origin v1.1.0
   ```

The tag triggers a fresh test/build. A mismatched tag or package version fails the build. After it succeeds, the release job downloads that exact build artifact and uses [softprops/action-gh-release](https://github.com/softprops/action-gh-release/tree/v3.0.3) to generate release notes, attach `subtable-X.Y.Z.zip`, and publish the release after uploading. Missing ZIPs fail the release step. Existing assets are preserved on reruns (`overwrite_files: false`); publish a new version to change their contents. The ZIP contains `manifest.json` at its root and can be unzipped and loaded through Chrome’s **Load unpacked** control. All workflow actions use explicit version tags.

Publishing uses the automatic `GITHUB_TOKEN`; no personal access token or additional secrets are needed. Only the release job receives `contents: write`. GitHub Actions and release creation must be allowed by your repository/organization settings. This publishes a GitHub release asset; Chrome Web Store distribution is a separate process.

## Structure

```text
extension/
  manifest.json         MV3 permissions and entry points
  export.html           Export tab UI
  styles.css            Responsive local-only styles
  icons/                Packaged PNG icons
  src/
    background.js       Toolbar → export tab
    app.js              UI, session connection, imports, table browsing, downloads
    audience.js         Accumulated subscribers, source identities, table queries
    downloads.js        Download ownership, completion, blob lifecycle
    patreon-observer.js Passive observation of the latest Audience request
    transport.js        Isolated session requests, endpoint validation, retries
    platforms.js        Platform adapters, normalization, pagination
    exporter.js         Collection, deduplication, consistency checks
    csv.js              Spreadsheet-safe CSV serialization
tests/                  Synthetic contract tests and Chromium smoke test
scripts/                Static validation and ZIP packaging
```
