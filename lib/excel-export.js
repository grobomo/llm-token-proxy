'use strict';

const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const ACCENT  = '58A6FF';
const BG      = '0D1117';
const SURFACE = '161B22';
const TEXT    = 'E6EDF3';
const GREEN   = '3FB950';
const YELLOW  = 'D29922';
const RED     = 'F85149';
const COLORS  = [ACCENT, GREEN, YELLOW, RED, '8B949E', 'BC8CFF', 'F78166', '7EE787'];

/**
 * Build an Excel workbook with hourly spend chart + data sheets.
 * Returns a Buffer (xlsx).
 */
async function buildExcelReport(db, range) {
  const interval = parseRange(range);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Token Tracker';
  wb.created = new Date();

  // ── Sheet 1: Hourly Spend (with chart data) ──
  const hourlyRows = queryAll(db, `
    SELECT strftime('%Y-%m-%d %H:00', timestamp) AS hour,
           SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    GROUP BY hour ORDER BY hour ASC
  `);

  const ws1 = wb.addWorksheet('Hourly Spend');
  styleSheet(ws1);
  ws1.columns = [
    { header: 'Hour', key: 'hour', width: 18 },
    { header: 'Cost (USD)', key: 'cost', width: 14 },
    { header: 'Calls', key: 'calls', width: 10 },
  ];
  styleHeaders(ws1);
  for (const r of hourlyRows) {
    const row = ws1.addRow({ hour: r.hour, cost: round4(r.cost), calls: r.calls });
    row.getCell('cost').numFmt = '$#,##0.0000';
  }
  // Summary row
  const sumRow = ws1.addRow({});
  sumRow.getCell(1).value = 'TOTAL';
  sumRow.getCell(1).font = { bold: true, color: { argb: ACCENT } };
  sumRow.getCell(2).value = { formula: `SUM(B2:B${hourlyRows.length + 1})` };
  sumRow.getCell(2).numFmt = '$#,##0.0000';
  sumRow.getCell(2).font = { bold: true };
  sumRow.getCell(3).value = { formula: `SUM(C2:C${hourlyRows.length + 1})` };
  sumRow.getCell(3).font = { bold: true };

  // ── Sheet 2: Model Breakdown ──
  const modelRows = queryAll(db, `
    SELECT model, COUNT(*) AS calls, SUM(estimated_cost_usd) AS cost,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    GROUP BY model ORDER BY cost DESC
  `);

  const ws2 = wb.addWorksheet('Model Breakdown');
  styleSheet(ws2);
  ws2.columns = [
    { header: 'Model', key: 'model', width: 30 },
    { header: 'Calls', key: 'calls', width: 10 },
    { header: 'Cost (USD)', key: 'cost', width: 14 },
    { header: 'Input Tokens', key: 'input_tokens', width: 14 },
    { header: 'Output Tokens', key: 'output_tokens', width: 14 },
    { header: 'Cache Read', key: 'cache_read', width: 14 },
    { header: 'Cache Write', key: 'cache_write', width: 14 },
  ];
  styleHeaders(ws2);
  for (const r of modelRows) {
    const row = ws2.addRow({
      model: r.model, calls: r.calls, cost: round4(r.cost),
      input_tokens: r.input_tokens || 0, output_tokens: r.output_tokens || 0,
      cache_read: r.cache_read || 0, cache_write: r.cache_write || 0,
    });
    row.getCell('cost').numFmt = '$#,##0.0000';
    row.getCell('input_tokens').numFmt = '#,##0';
    row.getCell('output_tokens').numFmt = '#,##0';
    row.getCell('cache_read').numFmt = '#,##0';
    row.getCell('cache_write').numFmt = '#,##0';
  }

  // ── Sheet 3: Project Costs ──
  const projectRows = queryAll(db, `
    SELECT COALESCE(project, '(untagged)') AS project, COUNT(*) AS calls,
           SUM(estimated_cost_usd) AS cost
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      AND http_status BETWEEN 200 AND 299
    GROUP BY project ORDER BY cost DESC LIMIT 20
  `);

  const ws3 = wb.addWorksheet('Project Costs');
  styleSheet(ws3);
  ws3.columns = [
    { header: 'Project', key: 'project', width: 40 },
    { header: 'Calls', key: 'calls', width: 10 },
    { header: 'Cost (USD)', key: 'cost', width: 14 },
  ];
  styleHeaders(ws3);
  for (const r of projectRows) {
    const row = ws3.addRow({ project: shortProject(r.project), calls: r.calls, cost: round4(r.cost) });
    row.getCell('cost').numFmt = '$#,##0.0000';
  }

  // ── Sheet 4: Raw Data ──
  const rawRows = queryAll(db, `
    SELECT timestamp, model, upstream, consumer, project, session_id,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           estimated_cost_usd, http_status, duration_ms
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    ORDER BY timestamp DESC
  `);

  const ws4 = wb.addWorksheet('Raw Data');
  styleSheet(ws4);
  ws4.columns = [
    { header: 'Timestamp', key: 'timestamp', width: 22 },
    { header: 'Model', key: 'model', width: 28 },
    { header: 'Upstream', key: 'upstream', width: 12 },
    { header: 'Consumer', key: 'consumer', width: 16 },
    { header: 'Project', key: 'project', width: 24 },
    { header: 'Session', key: 'session_id', width: 12 },
    { header: 'Input', key: 'input_tokens', width: 10 },
    { header: 'Output', key: 'output_tokens', width: 10 },
    { header: 'Cache Read', key: 'cache_read_tokens', width: 12 },
    { header: 'Cache Write', key: 'cache_write_tokens', width: 12 },
    { header: 'Cost (USD)', key: 'estimated_cost_usd', width: 12 },
    { header: 'Status', key: 'http_status', width: 8 },
    { header: 'Duration (ms)', key: 'duration_ms', width: 12 },
  ];
  styleHeaders(ws4);
  for (const r of rawRows) {
    const row = ws4.addRow({
      ...r,
      project: shortProject(r.project),
      session_id: (r.session_id || '').slice(0, 8),
    });
    row.getCell('estimated_cost_usd').numFmt = '$#,##0.0000';
    row.getCell('input_tokens').numFmt = '#,##0';
    row.getCell('output_tokens').numFmt = '#,##0';
    row.getCell('cache_read_tokens').numFmt = '#,##0';
    row.getCell('cache_write_tokens').numFmt = '#,##0';
  }

  // Generate base XLSX buffer, then inject chart
  const buf = await wb.xlsx.writeBuffer();
  return injectBarChart(buf, hourlyRows);
}

// ── Chart injection via OOXML XML ──

async function injectBarChart(xlsxBuf, hourlyRows) {
  if (hourlyRows.length === 0) return Buffer.from(xlsxBuf);

  const zip = await JSZip.loadAsync(xlsxBuf);

  // 1. Chart XML — bar chart of hourly cost
  const catXml = hourlyRows.map((r, i) =>
    `<c:pt idx="${i}"><c:v>${escXml(r.hour)}</c:v></c:pt>`
  ).join('');
  const valXml = hourlyRows.map((r, i) =>
    `<c:pt idx="${i}"><c:v>${round4(r.cost)}</c:v></c:pt>`
  ).join('');
  const count = hourlyRows.length;

  const chartXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p>
        <a:r><a:rPr lang="en-US" sz="1200" b="1"><a:solidFill><a:srgbClr val="${TEXT}"/></a:solidFill></a:rPr>
        <a:t>Hourly Spend (USD)</a:t></a:r>
      </a:p></c:rich></c:tx>
      <c:overlay val="0"/>
    </c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:varyColors val="0"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx><c:strRef><c:f>'Hourly Spend'!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Cost (USD)</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:spPr><a:solidFill><a:srgbClr val="${ACCENT}"/></a:solidFill><a:ln w="0"><a:noFill/></a:ln></c:spPr>
          <c:cat>
            <c:strRef>
              <c:f>'Hourly Spend'!$A$2:$A$${count + 1}</c:f>
              <c:strCache><c:ptCount val="${count}"/>${catXml}</c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>'Hourly Spend'!$B$2:$B$${count + 1}</c:f>
              <c:numCache><c:formatCode>$#,##0.0000</c:formatCode><c:ptCount val="${count}"/>${valXml}</c:numCache>
            </c:numRef>
          </c:val>
        </c:ser>
        <c:axId val="1"/>
        <c:axId val="2"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/>
        <c:txPr><a:bodyPr rot="-5400000"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"><a:solidFill><a:srgbClr val="${TEXT}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr/></a:p></c:txPr>
      </c:catAx>
      <c:valAx>
        <c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="$#,##0.00" sourceLinked="0"/><c:crossAx val="1"/>
        <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="${TEXT}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr/></a:p></c:txPr>
      </c:valAx>
    </c:plotArea>
    <c:plotVisOnly val="1"/>
  </c:chart>
</c:chartSpace>`;

  // 2. Drawing XML — anchors the chart on Sheet 1
  const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>14</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="2" name="Chart 1"/>
        <xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;

  // 3. Add files to ZIP
  zip.file('xl/charts/chart1.xml', chartXml);
  zip.file('xl/drawings/drawing1.xml', drawingXml);

  // 4. Drawing relationships (drawing -> chart)
  zip.file('xl/drawings/_rels/drawing1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`);

  // 5. Sheet1 relationships — add drawing reference
  const sheet1RelsPath = 'xl/worksheets/_rels/sheet1.xml.rels';
  let sheet1Rels = '';
  if (zip.file(sheet1RelsPath)) {
    sheet1Rels = await zip.file(sheet1RelsPath).async('string');
    // Insert before closing tag
    sheet1Rels = sheet1Rels.replace('</Relationships>',
      `<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`);
  } else {
    sheet1Rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
  }
  zip.file(sheet1RelsPath, sheet1Rels);

  // 6. Add drawing reference to sheet1.xml
  const sheet1Path = 'xl/worksheets/sheet1.xml';
  let sheet1 = await zip.file(sheet1Path).async('string');
  if (!sheet1.includes('<drawing')) {
    sheet1 = sheet1.replace('</worksheet>',
      '<drawing r:id="rId99"/></worksheet>');
  }
  zip.file(sheet1Path, sheet1);

  // 7. Update [Content_Types].xml
  const ctPath = '[Content_Types].xml';
  let ct = await zip.file(ctPath).async('string');
  if (!ct.includes('chart+xml')) {
    ct = ct.replace('</Types>',
      `<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
</Types>`);
  }
  zip.file(ctPath, ct);

  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

// ── Helpers ──

function parseRange(range) {
  const map = {
    '1h':  '-1 hours', '6h':  '-6 hours', '12h': '-12 hours',
    '24h': '-24 hours', '7d':  '-7 days', '30d': '-30 days',
  };
  return map[range] || '-24 hours';
}

function queryAll(db, sql) {
  try { return db.query(sql); }
  catch { return []; }
}

function round4(n) { return parseFloat((n || 0).toFixed(4)); }

function shortProject(p) {
  if (!p) return '(untagged)';
  return p.replace(/^.*[/\\]/, '');
}

function escXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function styleSheet(ws) {
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function styleHeaders(ws) {
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: TEXT } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SURFACE } };
  headerRow.border = { bottom: { style: 'thin', color: { argb: ACCENT } } };
}

module.exports = { buildExcelReport };
