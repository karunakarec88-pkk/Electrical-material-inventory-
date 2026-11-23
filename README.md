# Electrical Inventory - Material Inventory Application ⚡

Electrical Inventory is a premium, modern single-page dashboard designed for office and staff quarters maintenance teams to track purchases, usage, and availability of electrical spare parts (wires, cables, MCBs, DBs, switches, sockets, etc.). 

The application uses **Google Sheets as its database**, providing a no-infrastructure, secure, and user-friendly way to manage inventory. If no Google Sheet connection is set up, the application automatically loads in **Local Demo Mode** with realistic, pre-populated maintenance data for instant testing.

---

## 🚀 Key Features

*   **Premium Visual Dashboard**: High-fidelity dark glassmorphic interface featuring key metrics, charts (current stock levels vs thresholds, expenditure split), and dynamic low stock notifications.
*   **Google Sheet Database**: Direct, real-time read/write syncing with your own Google Sheet.
*   **Interactive Analytics**: Chart.js charts that dynamically display stock levels and source splits (GEM, Local Market, Tender Work).
*   **Maintenance Logs**: Separate entry flows for recording purchases (Stock-In) and usage (Stock-Out) with validation.
*   **Low Stock Alerts**: Automatically triggers alerts and visual warning badges when items drop below custom or calculated thresholds.
*   **Smart Search**: Natural query parsing allowing advanced searches such as:
    *   `low stock` (filters for items requiring reorder)
    *   `out of stock` (filters for empty items)
    *   `qty < 20` or `stock > 100` (operators for quick numeric filters)
    *   `GEM`, `Local Market`, or `Tender` (filters by supplier source)
    *   `wires`, `mcbs`, `switches` (category filters)

---

## 🔒 System Access & Login Credentials

Electrical Stock features Role-Based Access Control (RBAC) to distinguish between staff users and system administrators. The default access credentials configured in the system are:

*   **Administrator Role** (Full read/write permissions to record purchases, POs, usages, change thresholds, and settings):
    *   **Username**: `admin`
    *   **Password**: `admin123`
*   **Staff/User Role** (Read-only access to view stocks, dashboard analytics, search inventory, and run data syncs):
    *   **Username**: `staff`
    *   **Password**: `staff123`

To log out of a session and switch roles, click the red **Log Out** button at the bottom of the sidebar. Sessions are cached during browser execution but expire automatically when you close the browser tab.

---

## 🛠️ Step-by-Step Google Sheet Database Setup

Connect the application directly to your target spreadsheet:
**Spreadsheet URL:** [Open Spreadsheet](https://docs.google.com/spreadsheets/d/1a1mS5bTzXOWJenRossHYUN0MGiCf8N1pRe8sulVOaE4/edit)

Follow these steps:

1.  **Open the Spreadsheet**: Log into Google Sheets and open the target sheet.
2.  **Open Apps Script**: Go to the top menu and select **Extensions** ➡️ **Apps Script**.
3.  **Paste the API Code**: 
    *   Delete any default code in the script editor.
    *   Open the file [google-apps-script.js](google-apps-script.js) in this project folder.
    *   Copy all the code and paste it into the Google Apps Script editor.
    *   Click the **Save** (disk) icon.
4.  **Deploy as a Web App**:
    *   Click the **Deploy** button in the top right and select **New deployment**.
    *   Click the gear icon (⚙️) next to "Select type" and select **Web app**.
    *   Enter a description (e.g., "Material Inventory API").
    *   Set **Execute as** to **"Me (your-email@gmail.com)"**.
    *   Set **Who has access** to **"Anyone"**. *(This is required for the web browser to access the API safely without complex OAuth logins)*.
    *   Click **Deploy**.
5.  **Authorize Permissions**: If prompted, click *Authorize Access*, select your Google Account, click *Advanced* (at the bottom), and choose *Go to Material Inventory API (unsafe)* to grant access. *(Note: The script will request spreadsheet edit permissions and Google Drive save permissions to create the PO uploads folder)*.
6.  **Copy Web App URL**: Copy the generated **Web app URL** (which looks like `https://script.google.com/macros/s/.../exec`).
7.  **Connect in App on Every PC**:
    *   Open `index.html` in your browser.
    *   Go to the **Settings** tab.
    *   Paste the Web App URL in the input field and click **Save Configuration**.
    *   *(Tip: You can also paste the URL into `DEFAULT_SHEET_URL` at the top of `app.js` so that any PC opening `index.html` connects automatically without manual setup!)*
8.  **Important for Multi-PC PO / Invoice Visibility**:
    *   When uploading PO / Invoices, files are automatically uploaded to Google Drive in the folder `"Electrical Inventory POs and Invoices"` and made viewable by anyone with the link.
    *   Make sure **Who has access** is set to **"Anyone"** in Google Apps Script.
    *   If you had previously deployed the script and are updating it, always go to **Deploy** ➡️ **Manage deployments** ➡️ **Edit (pencil icon)** ➡️ select **Version: New version** ➡️ click **Deploy**. If you don't create a new version, Google Apps Script keeps running the old script code without Google Drive upload support!
    *   If you already uploaded invoices on one PC before connecting Google Drive, go to **Settings** and click **Push Local Invoices to Google Drive** to upload and link them permanently.

---

## 📊 Database Sheet Schema

The Google Sheet script self-initializes by automatically creating three sheets. You can view or write to them manually as well:

### 1. Purchases Sheet (Stock In)
Records all incoming material purchases.
*   **Indent No**: Indent number or bill reference.
*   **Received Date**: Date materials were received.
*   **Material Name**: Name of the electrical spare item.
*   **Make**: Brand or manufacturer of the item (e.g. Havells, Polycab, Finolex, Schneider, Legrand, Anchor).
*   **Unit**: Unit of measurement (Meters, Nos, Coils, Sets, DBs).
*   **Quantity**: Quantity purchased.
*   **Rate**: Cost per unit.
*   **Amount**: Automatically computed: `Quantity * Rate`.
*   **Source**: Supplier source (`GEM`, `Local Market`, or `Tender Work`).
*   **PO Link**: Clickable link to the uploaded PO PDF or image stored in Google Drive.

### 2. Usages Sheet (Stock Out)
Tracks material drawdowns for maintenance tasks.
*   **Date**: Date used.
*   **Material Name**: Name matching the purchase registry.
*   **Quantity**: Quantity drawn from inventory.
*   **Where Used**: Specific building/room (e.g., `Staff Quarters Block D-12`, `Main Office 2nd Floor`).
*   **Remarks**: Log details (e.g., `Replaced burned corridor light switch`).

### 3. Thresholds Sheet (Settings)
Persists custom warning thresholds for low stock triggers.
*   **Material Name**: Target item name.
*   **Low Stock Threshold**: Quantity below which a "Low Stock" warning is raised. If not set, defaults to 20% of purchases.

---

## ⚡ Smart Search Syntax Examples

Type these commands directly into the **Stock Inventory** search box for instant querying:

*   **Filter warnings**: Try typing `low stock` or `out of stock` to isolate items requiring attention.
*   **Check suppliers**: Type `GEM` or `Local` to see materials from respective sources.
*   **Numeric conditions**: Try typing `qty < 20`, `stock <= 5`, `qty > 50` to filter item ranges.
*   **Product Categories**: Type `cables` or `switches` or `mcbs` to get automatic categorizations.
