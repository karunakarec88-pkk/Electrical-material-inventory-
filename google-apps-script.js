/**
 * Google Apps Script for Material Inventory Application
 * This script runs in Google Sheets and acts as a database API for the frontend web application.
 * 
 * Supports uploading PO documents directly into a dedicated folder in Google Drive.
 * 
 * Instructions:
 * 1. Open your Google Sheet: https://docs.google.com/spreadsheets/d/1a1mS5bTzXOWJenRossHYUN0MGiCf8N1pRe8sulVOaE4/edit
 * 2. Click "Extensions" -> "Apps Script"
 * 3. Replace the default code with this file's code
 * 4. Click the "Save" icon
 * 5. Important Deployment Steps:
 *    - If FIRST time deploying:
 *      a. Click "Deploy" -> "New deployment"
 *      b. Under "Select type" choose "Web app"
 *      c. Set Description: "Material Inventory API with Google Drive PO Upload"
 *      d. Set Execute as: "Me (your-email@gmail.com)"
 *      e. Set Who has access: "Anyone" (Required so all office PCs can access without Google login prompt)
 *      f. Click "Deploy", authorize permissions for both Google Sheets AND Google Drive.
 *    - If ALREADY deployed earlier (UPDATING existing deployment):
 *      a. Click "Deploy" -> "Manage deployments"
 *      b. Click the pencil (Edit) icon on the active Web App deployment
 *      c. Under "Version" choose "New version"
 *      d. Click "Deploy" (This ensures your Web App URL runs this updated code with Drive upload support!)
 * 6. Copy the Web app URL and paste it in Settings of the Material Inventory App on each PC (or set DEFAULT_SHEET_URL in app.js).
 */

// Helper to find column index (1-based for getRange) matching aliases or substring
function findColumnIndex(headers, aliases, defaultCol) {
  for (var h = 0; h < headers.length; h++) {
    var raw = (headers[h] || "").toString().toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    for (var a = 0; a < aliases.length; a++) {
      if (raw === aliases[a]) return h + 1;
    }
  }
  for (var h = 0; h < headers.length; h++) {
    var raw = (headers[h] || "").toString().toLowerCase().trim();
    for (var a = 0; a < aliases.length; a++) {
      if (raw.indexOf(aliases[a]) !== -1) return h + 1;
    }
  }
  return defaultCol;
}

// Handle GET requests: Fetch all data OR perform actions via query parameters (GET writes)
function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Ensure required sheets exist, if not, create them
  var purchasesSheet = ss.getSheetByName("Purchases") || ss.insertSheet("Purchases");
  var usagesSheet = ss.getSheetByName("Usages") || ss.insertSheet("Usages");
  var thresholdsSheet = ss.getSheetByName("Thresholds") || ss.insertSheet("Thresholds");
  
  // Initialize headers if empty or auto-migrate
  if (purchasesSheet.getLastRow() === 0) {
    purchasesSheet.appendRow(["Indent No", "Received Date", "Material Name", "Make", "Unit", "Quantity", "Rate", "Amount", "Source", "PO Link"]);
  } else {
    var headers = purchasesSheet.getRange(1, 1, 1, Math.max(purchasesSheet.getLastColumn(), 1)).getValues()[0];
    var hasMake = headers.some(function(h) { return h.toString().toLowerCase().trim() === "make"; });
    if (!hasMake && headers.length >= 3) {
      purchasesSheet.insertColumnAfter(3);
      purchasesSheet.getRange(1, 4).setValue("Make");
    }
  }
  
  if (usagesSheet.getLastRow() === 0) {
    usagesSheet.appendRow(["Date", "Material Name", "Quantity", "Where Used", "Remarks"]);
  }
  if (thresholdsSheet.getLastRow() === 0) {
    thresholdsSheet.appendRow(["Material Name", "Low Stock Threshold"]);
  }
  
  // If there's an action query parameter, perform write via GET (CORS-safe fallback, no files)
  if (e && e.parameter && e.parameter.action && e.parameter.action !== "getData") {
    try {
      var action = e.parameter.action;
      if (action === "addPurchase") {
        purchasesSheet.appendRow([
          e.parameter.indentNo,
          e.parameter.receivedDate,
          e.parameter.materialName,
          e.parameter.make || "",
          e.parameter.unit,
          Number(e.parameter.quantity),
          Number(e.parameter.rate),
          Number(e.parameter.amount),
          e.parameter.source,
          e.parameter.poLink || e.parameter.fileUrl || ""
        ]);
        SpreadsheetApp.flush();
      } else if (action === "addUsage") {
        usagesSheet.appendRow([
          e.parameter.date,
          e.parameter.materialName,
          Number(e.parameter.quantity),
          e.parameter.whereUsed,
          e.parameter.remarks
        ]);
        SpreadsheetApp.flush();
      } else if (action === "updateThreshold") {
        var data = thresholdsSheet.getDataRange().getValues();
        var found = false;
        for (var i = 1; i < data.length; i++) {
          if (data[i][0].toString().toLowerCase().trim() === e.parameter.materialName.toString().toLowerCase().trim()) {
            thresholdsSheet.getRange(i + 1, 2).setValue(Number(e.parameter.threshold));
            found = true;
            break;
          }
        }
        if (!found) {
          thresholdsSheet.appendRow([e.parameter.materialName, Number(e.parameter.threshold)]);
        }
      } else if (action === "updateMake") {
        var data = purchasesSheet.getDataRange().getValues();
        var headers = data[0];
        var makeCol = -1;
        for (var h = 0; h < headers.length; h++) {
          if (headers[h].toString().toLowerCase().trim() === "make") {
            makeCol = h + 1;
            break;
          }
        }
        if (makeCol > 0) {
          var indentQuery = (e.parameter.indentNo || "").toString().toLowerCase().trim();
          var matQuery = (e.parameter.materialName || "").toString().toLowerCase().trim();
          var newMakeVal = e.parameter.make || "";
          for (var i = 1; i < data.length; i++) {
            var rowIndent = data[i][0].toString().toLowerCase().trim();
            var rowMat = data[i][2].toString().toLowerCase().trim();
            if ((!indentQuery || rowIndent === indentQuery) && rowMat === matQuery) {
              purchasesSheet.getRange(i + 1, makeCol).setValue(newMakeVal);
              if (indentQuery) break;
            }
          }
        }
      } else if (action === "updateInvoice" || action === "deleteInvoice") {
        var data = purchasesSheet.getDataRange().getValues();
        var headers = data[0];
        var poLinkCol = findColumnIndex(headers, ["polink", "invoice", "fileurl", "invoicelink", "podocument", "poinvoice", "attachment"], 10);
        var indentCol = findColumnIndex(headers, ["indentno", "indent", "indentnumber", "indentid"], 1) - 1;
        var matCol = findColumnIndex(headers, ["materialname", "material", "itemname", "item", "description"], 3) - 1;

        var indentQuery = (e.parameter.indentNo || "").toString().toLowerCase().trim();
        var matQuery = (e.parameter.materialName || "").toString().toLowerCase().trim();
        var explicitFileUrl = (e.parameter.fileUrl || e.parameter.oldFileUrl || "").toString().trim();
        var isDelete = action === "deleteInvoice" || (!e.parameter.poLink && !e.parameter.fileUrl);
        var newPoLink = isDelete ? "" : (e.parameter.poLink || e.parameter.fileUrl || "");
        var deleteAllForIndent = e.parameter.deleteAllForIndent === true || e.parameter.deleteAllForIndent === "true" || !matQuery;

        if (explicitFileUrl && isDelete) {
          deleteFileFromDrive(explicitFileUrl);
        }

        for (var i = 1; i < data.length; i++) {
          var rowIndent = data[i][indentCol].toString().toLowerCase().trim();
          var rowMat = data[i][matCol].toString().toLowerCase().trim();
          var currentPoLink = data[i][poLinkCol - 1] ? data[i][poLinkCol - 1].toString().trim() : "";
          var indentMatch = !indentQuery || rowIndent === indentQuery;
          var matMatch = (!matQuery || rowMat === matQuery) || deleteAllForIndent;
          var fileMatch = explicitFileUrl && currentPoLink === explicitFileUrl;

          if ((indentMatch && matMatch) || fileMatch) {
            if (isDelete && currentPoLink && currentPoLink !== explicitFileUrl) {
              deleteFileFromDrive(currentPoLink);
            }
            purchasesSheet.getRange(i + 1, poLinkCol).setValue(newPoLink);
            if (matQuery && !deleteAllForIndent && indentQuery && !fileMatch) break;
          }
        }
        SpreadsheetApp.flush();
        return ContentService.createTextOutput(JSON.stringify({
          status: "success",
          action: action,
          message: isDelete ? "PO / Invoice deleted from Google Sheet and trashed from Google Drive." : "Invoice updated successfully."
        })).setMimeType(ContentService.MimeType.JSON);
      } else if (action === "deleteUsage") {
        var data = usagesSheet.getDataRange().getValues();
        var dateQuery = normalizeDateStr(e.parameter.date || "");
        var matQuery = (e.parameter.materialName || "").toString().toLowerCase().trim();
        var qtyQuery = Number(e.parameter.quantity);
        var whereUsedQuery = (e.parameter.whereUsed || "").toString().toLowerCase().trim();
        for (var i = 1; i < data.length; i++) {
          var rowDate = normalizeDateStr(data[i][0]);
          var rowMat = data[i][1].toString().toLowerCase().trim();
          var rowQty = Number(data[i][2]);
          var rowWhere = (data[i][3] || "").toString().toLowerCase().trim();
          
          var dateMatch = !dateQuery || rowDate === dateQuery;
          var matMatch = rowMat === matQuery;
          var qtyMatch = isNaN(qtyQuery) || Math.abs(rowQty) === Math.abs(qtyQuery);
          var whereMatch = !whereUsedQuery || rowWhere === whereUsedQuery;
          
          if (matMatch && qtyMatch && (dateMatch || whereMatch)) {
            usagesSheet.deleteRow(i + 1);
            break;
          }
        }
        SpreadsheetApp.flush();
      } else if (action === "deletePurchase") {
        var data = purchasesSheet.getDataRange().getValues();
        var headers = data[0];
        var indentCol = findColumnIndex(headers, ["indentno", "indent", "indentnumber", "indentid"], 1) - 1;
        var dateCol = findColumnIndex(headers, ["receiveddate", "date", "purchasedate"], 2) - 1;
        var matCol = findColumnIndex(headers, ["materialname", "material", "itemname", "item", "description"], 3) - 1;
        var poLinkCol = findColumnIndex(headers, ["polink", "invoice", "fileurl", "invoicelink", "podocument", "poinvoice", "attachment"], 10);

        var indentQuery = (e.parameter.indentNo || "").toString().toLowerCase().trim();
        var matQuery = (e.parameter.materialName || "").toString().toLowerCase().trim();
        var dateQuery = normalizeDateStr(e.parameter.date || "");
        var deleteAllForIndent = e.parameter.deleteAllForIndent === true || e.parameter.deleteAllForIndent === "true";

        for (var i = data.length - 1; i >= 1; i--) {
          var rowIndent = data[i][indentCol].toString().toLowerCase().trim();
          var rowMat = data[i][matCol].toString().toLowerCase().trim();
          var rowDate = normalizeDateStr(data[i][dateCol]);
          var currentPoLink = data[i][poLinkCol - 1] ? data[i][poLinkCol - 1].toString().trim() : "";

          var indentMatch = !indentQuery || rowIndent === indentQuery;
          var matMatch = (!matQuery || rowMat === matQuery) || deleteAllForIndent;
          var dateMatch = !dateQuery || rowDate === dateQuery;

          if (indentMatch && (matMatch || deleteAllForIndent) && (dateMatch || !dateQuery)) {
            if (currentPoLink) {
              deleteFileFromDrive(currentPoLink);
            }
            purchasesSheet.deleteRow(i + 1);
            if (!deleteAllForIndent && matQuery) break;
          }
        }
        SpreadsheetApp.flush();
        return ContentService.createTextOutput(JSON.stringify({
          status: "success",
          action: "deletePurchase",
          message: "Purchase entry deleted from Google Sheet."
        })).setMimeType(ContentService.MimeType.JSON);
      }
      
      var response = { status: "success", action: action, message: "Write successful via GET" };
      return ContentService.createTextOutput(JSON.stringify(response))
        .setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  
  // Normal GET behavior: read all tables and return them
  var purchases = getSheetData(purchasesSheet);
  var usages = getSheetData(usagesSheet);
  var thresholds = getSheetData(thresholdsSheet);
  
  var response = {
    purchases: purchases,
    usages: usages,
    thresholds: thresholds
  };
  
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

// Handle POST requests: Write data (processes JSON payload, handles file uploads)
function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var postData = JSON.parse(e.postData.contents);
    var action = postData.action;
    
    var purchasesSheet = ss.getSheetByName("Purchases") || ss.insertSheet("Purchases");
    var usagesSheet = ss.getSheetByName("Usages") || ss.insertSheet("Usages");
    var thresholdsSheet = ss.getSheetByName("Thresholds") || ss.insertSheet("Thresholds");
    
    if (action === "addPurchase") {
      var fileUrl = postData.poLink || postData.fileUrl || "";
      
      // Check if a PO file is uploaded
      if (postData.fileData && postData.fileName) {
        fileUrl = saveFileToDrive(postData.fileName, postData.fileData, postData.contentType, postData.indentNo, postData.materialName);
      }
      
      purchasesSheet.appendRow([
        postData.indentNo,
        postData.receivedDate,
        postData.materialName,
        postData.make || "",
        postData.unit,
        Number(postData.quantity),
        Number(postData.rate),
        Number(postData.amount),
        postData.source,
        fileUrl
      ]);
    } else if (action === "addPurchaseBatch") {
      var batchFileUrl = postData.poLink || postData.fileUrl || "";
      
      // Check if a shared PO file is uploaded at batch level
      if (postData.fileData && postData.fileName) {
        batchFileUrl = saveFileToDrive(postData.fileName, postData.fileData, postData.contentType, postData.indentNo);
      }
      
      var items = postData.items;
      if (items && Array.isArray(items)) {
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var itemFileUrl = item.poLink || item.fileUrl || batchFileUrl || "";
          if (item.fileData && item.fileName) {
            itemFileUrl = saveFileToDrive(item.fileName, item.fileData, item.contentType, postData.indentNo, item.materialName);
          }
          purchasesSheet.appendRow([
            postData.indentNo,
            postData.receivedDate,
            item.materialName,
            item.make || "",
            item.unit,
            Number(item.quantity),
            Number(item.rate),
            Number(item.amount),
            postData.source,
            itemFileUrl
          ]);
        }
      }
    } else if (action === "addUsage") {
      usagesSheet.appendRow([
        postData.date,
        postData.materialName,
        Number(postData.quantity),
        postData.whereUsed,
        postData.remarks
      ]);
    } else if (action === "updateThreshold") {
      var data = thresholdsSheet.getDataRange().getValues();
      var found = false;
      for (var i = 1; i < data.length; i++) {
        if (data[i][0].toString().toLowerCase().trim() === postData.materialName.toString().toLowerCase().trim()) {
          thresholdsSheet.getRange(i + 1, 2).setValue(Number(postData.threshold));
          found = true;
          break;
        }
      }
      if (!found) {
        thresholdsSheet.appendRow([postData.materialName, Number(postData.threshold)]);
      }
    } else if (action === "updateMake") {
      var data = purchasesSheet.getDataRange().getValues();
      var headers = data[0];
      var makeCol = findColumnIndex(headers, ["make", "brand"], 4);
      if (makeCol > 0) {
        var indentQuery = (postData.indentNo || "").toString().toLowerCase().trim();
        var matQuery = (postData.materialName || "").toString().toLowerCase().trim();
        var newMakeVal = postData.make || "";
        for (var i = 1; i < data.length; i++) {
          var rowIndent = data[i][0].toString().toLowerCase().trim();
          var rowMat = data[i][2].toString().toLowerCase().trim();
          if ((!indentQuery || rowIndent === indentQuery) && rowMat === matQuery) {
            purchasesSheet.getRange(i + 1, makeCol).setValue(newMakeVal);
            if (indentQuery) break;
          }
        }
        SpreadsheetApp.flush();
      }
    } else if (action === "updateInvoice" || action === "deleteInvoice") {
      var data = purchasesSheet.getDataRange().getValues();
      var headers = data[0];
      var poLinkCol = findColumnIndex(headers, ["polink", "invoice", "fileurl", "invoicelink", "podocument", "poinvoice", "attachment"], 10);
      var indentCol = findColumnIndex(headers, ["indentno", "indent", "indentnumber", "indentid"], 1) - 1;
      var matCol = findColumnIndex(headers, ["materialname", "material", "itemname", "item", "description"], 3) - 1;

      var isDelete = action === "deleteInvoice" || (!postData.fileData && !postData.poLink && !postData.fileUrl);
      var fileUrl = isDelete ? "" : (postData.poLink || postData.fileUrl || "");

      // Check if a new file is uploaded in this POST request
      if (postData.fileData && postData.fileName) {
        if (postData.oldFileUrl) {
          deleteFileFromDrive(postData.oldFileUrl);
        }
        fileUrl = saveFileToDrive(postData.fileName, postData.fileData, postData.contentType, postData.indentNo || "Invoice", postData.materialName || "");
      } else if (postData.oldFileUrl && isDelete) {
        deleteFileFromDrive(postData.oldFileUrl);
      }

      var explicitFileUrl = postData.fileUrl || postData.oldFileUrl || "";
      if (explicitFileUrl && isDelete) {
        deleteFileFromDrive(explicitFileUrl);
      }

      var indentQuery = (postData.indentNo || "").toString().toLowerCase().trim();
      var matQuery = (postData.materialName || "").toString().toLowerCase().trim();
      var deleteAllForIndent = postData.deleteAllForIndent === true || postData.deleteAllForIndent === "true" || !matQuery;

      for (var i = 1; i < data.length; i++) {
        var rowIndent = data[i][indentCol].toString().toLowerCase().trim();
        var rowMat = data[i][matCol].toString().toLowerCase().trim();
        var currentPoLink = data[i][poLinkCol - 1] ? data[i][poLinkCol - 1].toString().trim() : "";
        var indentMatch = !indentQuery || rowIndent === indentQuery;
        var matMatch = (!matQuery || rowMat === matQuery) || deleteAllForIndent;
        var fileMatch = explicitFileUrl && currentPoLink === explicitFileUrl;

        if ((indentMatch && matMatch) || fileMatch) {
          if (isDelete && currentPoLink && currentPoLink !== explicitFileUrl) {
            deleteFileFromDrive(currentPoLink);
          }
          purchasesSheet.getRange(i + 1, poLinkCol).setValue(fileUrl);
          if (matQuery && indentQuery && !deleteAllForIndent && !fileMatch) break;
        }
      }
      SpreadsheetApp.flush();
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        action: action,
        fileUrl: fileUrl,
        message: isDelete ? "PO / Invoice deleted from Google Sheet and trashed from Google Drive." : "PO / Invoice updated successfully."
      })).setMimeType(ContentService.MimeType.JSON);
    } else if (action === "deleteUsage") {
      var data = usagesSheet.getDataRange().getValues();
      var dateQuery = normalizeDateStr(postData.date || "");
      var matQuery = (postData.materialName || "").toString().toLowerCase().trim();
      var qtyQuery = Number(postData.quantity);
      var whereUsedQuery = (postData.whereUsed || "").toString().toLowerCase().trim();
      for (var i = 1; i < data.length; i++) {
        var rowDate = normalizeDateStr(data[i][0]);
        var rowMat = data[i][1].toString().toLowerCase().trim();
        var rowQty = Number(data[i][2]);
        var rowWhere = (data[i][3] || "").toString().toLowerCase().trim();
        
        var dateMatch = !dateQuery || rowDate === dateQuery;
        var matMatch = rowMat === matQuery;
        var qtyMatch = isNaN(qtyQuery) || Math.abs(rowQty) === Math.abs(qtyQuery);
        var whereMatch = !whereUsedQuery || rowWhere === whereUsedQuery;
        
        if (matMatch && qtyMatch && (dateMatch || whereMatch)) {
          usagesSheet.deleteRow(i + 1);
          break;
        }
      }
      SpreadsheetApp.flush();
    } else if (action === "deletePurchase") {
      var data = purchasesSheet.getDataRange().getValues();
      var headers = data[0];
      var indentCol = findColumnIndex(headers, ["indentno", "indent", "indentnumber", "indentid"], 1) - 1;
      var dateCol = findColumnIndex(headers, ["receiveddate", "date", "purchasedate"], 2) - 1;
      var matCol = findColumnIndex(headers, ["materialname", "material", "itemname", "item", "description"], 3) - 1;
      var poLinkCol = findColumnIndex(headers, ["polink", "invoice", "fileurl", "invoicelink", "podocument", "poinvoice", "attachment"], 10);

      var indentQuery = (postData.indentNo || "").toString().toLowerCase().trim();
      var matQuery = (postData.materialName || "").toString().toLowerCase().trim();
      var dateQuery = normalizeDateStr(postData.date || "");
      var deleteAllForIndent = postData.deleteAllForIndent === true || postData.deleteAllForIndent === "true";

      for (var i = data.length - 1; i >= 1; i--) {
        var rowIndent = data[i][indentCol].toString().toLowerCase().trim();
        var rowMat = data[i][matCol].toString().toLowerCase().trim();
        var rowDate = normalizeDateStr(data[i][dateCol]);
        var currentPoLink = data[i][poLinkCol - 1] ? data[i][poLinkCol - 1].toString().trim() : "";

        var indentMatch = !indentQuery || rowIndent === indentQuery;
        var matMatch = (!matQuery || rowMat === matQuery) || deleteAllForIndent;
        var dateMatch = !dateQuery || rowDate === dateQuery;

        if (indentMatch && (matMatch || deleteAllForIndent) && (dateMatch || !dateQuery)) {
          if (currentPoLink) {
            deleteFileFromDrive(currentPoLink);
          }
          purchasesSheet.deleteRow(i + 1);
          if (!deleteAllForIndent && matQuery) break;
        }
      }
      SpreadsheetApp.flush();
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        action: "deletePurchase",
        message: "Purchase entry deleted from Google Sheet."
      })).setMimeType(ContentService.MimeType.JSON);
    } else {
      throw new Error("Invalid action: " + action);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ status: "success", action: action, fileUrl: fileUrl || "", message: "Write successful via POST" }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Helper to trash/delete a file in Google Drive given its Drive URL or File ID
function deleteFileFromDrive(urlOrId) {
  if (!urlOrId || typeof urlOrId !== 'string') return false;
  var str = urlOrId.trim();
  if (!str) return false;
  
  var fileId = '';
  var match = str.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) fileId = match[1];
  else {
    match = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (match && match[1]) fileId = match[1];
    else {
      match = str.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) fileId = match[1];
      else if (/^[a-zA-Z0-9_-]{20,}$/.test(str)) fileId = str;
    }
  }

  if (fileId) {
    try {
      var file = DriveApp.getFileById(fileId);
      if (file) {
        file.setTrashed(true);
        Logger.log("Successfully trashed Google Drive file: " + fileId);
        return true;
      }
    } catch (e) {
      Logger.log("Notice: Could not trash Drive file " + fileId + ": " + e.message);
    }
  }
  return false;
}

// Helper to save uploaded file into a Google Drive Folder and return public link
function saveFileToDrive(fileName, base64DataOrDataUrl, contentType, indentNo, materialName) {
  var folderName = "Electrical Inventory POs and Invoices";
  var folders = DriveApp.getFoldersByName(folderName);
  var folder;
  
  if (folders.hasNext()) {
    folder = folders.next();
  } else {
    var oldFolders = DriveApp.getFoldersByName("Electrical Stock POs");
    if (oldFolders.hasNext()) {
      folder = oldFolders.next();
      try { folder.setName(folderName); } catch(e) {}
    } else {
      folder = DriveApp.createFolder(folderName);
    }
  }
  
  // Safely extract raw Base64 data and detect content type
  var rawBase64 = (base64DataOrDataUrl || "").toString().trim();
  var detectedType = contentType || "application/octet-stream";
  
  if (rawBase64.indexOf(",") > -1) {
    var parts = rawBase64.split(",");
    var metaMatch = parts[0].match(/data:(.*?);/);
    if (metaMatch && metaMatch[1]) {
      detectedType = metaMatch[1];
    }
    rawBase64 = parts.slice(1).join(",");
  }
  
  // Clean whitespace and linebreaks
  rawBase64 = rawBase64.replace(/\s/g, "");
  if (!rawBase64) {
    throw new Error("Empty file data received for Drive upload.");
  }
  
  var decoded = Utilities.base64Decode(rawBase64);
  
  var fileExtension = ".pdf";
  if (fileName && fileName.indexOf('.') > -1) {
    fileExtension = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
  } else if (detectedType) {
    if (detectedType.indexOf("png") > -1) fileExtension = ".png";
    else if (detectedType.indexOf("jpeg") > -1 || detectedType.indexOf("jpg") > -1) fileExtension = ".jpg";
    else if (detectedType.indexOf("pdf") > -1) fileExtension = ".pdf";
  }

  var cleanIndentNo = (indentNo || "Invoice").toString().replace(/[^a-zA-Z0-9-_]/g, "_");
  var cleanMatName = (materialName || "").toString().replace(/[^a-zA-Z0-9-_]/g, "_");
  
  var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT", "yyyyMMdd_HHmmss");
  var savedName = "PO_" + cleanIndentNo + (cleanMatName ? "_" + cleanMatName : "") + "_" + timestamp + fileExtension;
  
  var blob = Utilities.newBlob(decoded, detectedType, savedName);
  var file = folder.createFile(blob);
  
  // Make the file readable by anyone with the link so it can be viewed on any PC
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (errSharing) {
    try {
      file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (errDomain) {
      Logger.log("Sharing permission warning: " + errDomain);
    }
  }
  
  return file.getUrl();
}

// Helper to normalize dates for comparison across format variations
function normalizeDateStr(d) {
  if (!d) return "";
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return "";
    var y = d.getFullYear();
    var m = ("0" + (d.getMonth() + 1)).slice(-2);
    var day = ("0" + d.getDate()).slice(-2);
    return y + "-" + m + "-" + day;
  }
  var s = d.toString().trim();
  if (s.includes('.') || s.includes('/')) {
    var sep = s.includes('.') ? '.' : '/';
    var parts = s.split(sep);
    if (parts.length === 3) {
      var p1 = parseInt(parts[0], 10);
      var p2 = parseInt(parts[1], 10);
      var p3 = parseInt(parts[2], 10);
      if (p3 > 1000) {
        var dayStr = ("0" + p1).slice(-2);
        var monthStr = ("0" + p2).slice(-2);
        return p3 + "-" + monthStr + "-" + dayStr;
      }
    }
  }
  if (s.includes('-')) {
    var parts = s.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      return s;
    }
  }
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    var y = parsed.getFullYear();
    var m = ("0" + (parsed.getMonth() + 1)).slice(-2);
    var day = ("0" + parsed.getDate()).slice(-2);
    return y + "-" + m + "-" + day;
  }
  return s;
}

// Helper to convert sheet data into JSON array of objects
function getSheetData(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  var lastColumn = sheet.getLastColumn();
  
  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  
  var result = [];
  for (var i = 0; i < values.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      var headerName = headers[j];
      var val = values[i][j];
      
      // Parse dates nicely for the JSON response
      if (val instanceof Date) {
        row[headerName] = val.toISOString().split('T')[0];
      } else {
        row[headerName] = val;
      }
    }
    result.push(row);
  }
  return result;
}

/**
 * TEST & AUTHORIZATION FUNCTION
 * Run this function directly inside the Google Apps Script editor (click "Run" button)
 * to trigger the Google Drive permission dialog and authorize Drive access!
 */
function testDrivePermissions() {
  try {
    var folderName = "Electrical Inventory POs and Invoices";
    var folders = DriveApp.getFoldersByName(folderName);
    var folder;
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder(folderName);
    }
    
    // Create small test file
    var testBlob = Utilities.newBlob("Google Drive connection test successful!", "text/plain", "connection_test.txt");
    var testFile = folder.createFile(testBlob);
    try {
      testFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch(e) {}
    
    Logger.log("SUCCESS! Folder verified and test file created: " + testFile.getUrl());
    testFile.setTrashed(true); // remove test file
    return "SUCCESS: Google Drive permissions are authorized and working properly!";
  } catch (err) {
    Logger.log("ERROR: " + err.message);
    throw err;
  }
}


