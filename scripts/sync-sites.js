const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SHEET_ID = '1qqW-pdyTbdCCek3w0pfLcahTLbK0jrh_FiuHEAFU_sM';
const SHEET_RANGE = 'Sheet1!A2:J1000';

function toBool(val) {
  if (!val) return false;
  return ['yes', 'true', '1', 'y'].includes(val.toString().toLowerCase().trim());
}

function toSlug(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname.replace(/\./g, '-');
  } catch {
    return url.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  }
}

async function syncSites() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const rows = response.data.values || [];

  const sites = rows
    .filter(row => row[0] && row[1])
    .map(row => {
      const url = row[1]?.trim() || '';
      return {
        name: row[0]?.trim() || '',
        url,
        slug: toSlug(url),
        clientEmail: row[2]?.trim() || '',
        host: row[3]?.trim() || '',
        managedByDbd: toBool(row[4]),
        sshAccess: toBool(row[5]),
        notes: row[6]?.trim() || '',
        active: row[7] === undefined ? true : toBool(row[7]),
        sshInstallName: row[8]?.trim() || '',
        siteType: row[9]?.trim() || '',
      };
    })
    .filter(site => site.active);

  const output = { sites };
  fs.writeFileSync(
    path.join(__dirname, '..', 'sites.json'),
    JSON.stringify(output, null, 2)
  );

  console.log(`Synced ${sites.length} active sites from Google Sheets`);
}

syncSites().catch(err => { console.error(err); process.exit(1); });
