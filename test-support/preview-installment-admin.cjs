/* eslint-disable @typescript-eslint/no-require-imports -- This standalone CommonJS fixture needs a TS require hook, not a Next server or public test route. */
/* Local visual fixture only; no production route, database, credentials, script
 * hydration or payment endpoints. Renders the actual admin component and built
 * CSS. Listens ONLY on loopback. Stop with Ctrl+C after the visual check. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const originalLoad = Module._load;
Module._load = function(name, parent, ...rest) {
  if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
  return originalLoad.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, parent, ...rest);
};
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => {
  if (!filename.startsWith(root + path.sep)) throw new Error('Fixture import outside repository');
  const text = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
};
const { InstallmentReview } = require('../app/admin/commerce/installments/InstallmentReview');
const common = {paymentCount:3,purchaseId:null,status:'active',stop:null};
const initial = {nextCursor:null,plans:[
  {...common,id:'00000000-0000-4000-8000-000000000001',title:'QA Staging — Mentorship installment plan',totalCents:199900,
    holds:['invoice_recovery'],recoveries:[{outcome:'action_required',observedAt:'2026-09-06T12:00:00Z'}]},
  {...common,id:'00000000-0000-4000-8000-000000000002',title:'QA Staging — Course payment plan',totalCents:99900,
    holds:[],recoveries:[]},
  {...common,id:'00000000-0000-4000-8000-000000000003',title:'QA Staging — Approved billing stop',totalCents:12000,status:'canceled',
    holds:['cancellation_review'],recoveries:[],stop:{requestId:'00000000-0000-4000-8000-000000000004',status:'complete',ownedByCaller:true}},
]};
const markup=renderToStaticMarkup(React.createElement(InstallmentReview,{initial}));
const chunks=path.join(root,'.next','static','chunks');
const styles=fs.readdirSync(chunks).filter(n=>n.endsWith('.css'));
if(!styles.length)throw new Error('Run build before visual preview');
const document=(mobile=false)=>`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local installment admin visual fixture</title>${styles.map(n=>`<link rel="stylesheet" href="/${n}">`).join('')}<style>body{margin:0;background:#faf8ff;color:#18181b;font-family:Arial,sans-serif}main{margin:auto;max-width:${mobile?'390px':'1150px'};padding:${mobile?'20px 16px':'32px'}}.fixture{padding:12px;text-align:center;font-size:12px;background:#eee8f8;color:#6b4fae}a,button,input{pointer-events:none}</style><body><div class="fixture">LOCAL VISUAL FIXTURE · synthetic data · controls inactive</div><main>${markup}</main></body></html>`;
const server=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'none'; img-src 'none'; frame-ancestors 'none'; form-action 'none'");
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  const name=(req.url||'/').slice(1);
  if(styles.includes(name)){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(chunks,name)));return;}
  if(req.url!=='/'&&req.url!=='/mobile'){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(document(req.url==='/mobile'));
});
server.listen(3217,'127.0.0.1',()=>process.stdout.write('Visual fixture at http://127.0.0.1:3217 (loopback only)\n'));
