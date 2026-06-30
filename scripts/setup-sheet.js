const { google } = require('googleapis');

const SHEET_ID = '1qqW-pdyTbdCCek3w0pfLcahTLbK0jrh_FiuHEAFU_sM';
const SITE_TYPE_OPTIONS = ['Tourism', 'Economic Development', 'Planning', 'Internal'];

async function setup() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Get sheet ID (tab ID, not spreadsheet ID)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetTabId = meta.data.sheets[0].properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        // Add "Site Type" header to J1
        {
          updateCells: {
            range: {
              sheetId: sheetTabId,
              startRowIndex: 0, endRowIndex: 1,
              startColumnIndex: 9, endColumnIndex: 10,
            },
            rows: [{ values: [{ userEnteredValue: { stringValue: 'Site Type' } }] }],
            fields: 'userEnteredValue',
          },
        },
        // Add dropdown validation to J2:J1000
        {
          setDataValidation: {
            range: {
              sheetId: sheetTabId,
              startRowIndex: 1, endRowIndex: 1000,
              startColumnIndex: 9, endColumnIndex: 10,
            },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: SITE_TYPE_OPTIONS.map(v => ({ userEnteredValue: v })),
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },
      ],
    },
  });

  console.log('Sheet setup complete — column J now has "Site Type" header and dropdown.');
}

setup().catch(err => { console.error(err); process.exit(1); });
