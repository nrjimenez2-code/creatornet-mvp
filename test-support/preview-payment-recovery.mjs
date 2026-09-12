/* Offline visual QA of the ACTUAL customer component and app stylesheet.
 * Synthetic fixture only. No env files, server clients, hydration or network.
 * Usage: node test-support/preview-payment-recovery.mjs <output directory>
 */
import fs from "node:fs";
import path from "node:path";
import Module, {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import ts from "typescript";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."), output = process.argv[2];
const nativeRequire = createRequire(import.meta.url);
if (!output || !path.isAbsolute(output)) throw new Error("Pass an absolute visual QA output directory");
const contract = path.join(root,"lib/installments/buyerRecoveryView.ts");
const component = path.join(root,"app/payments/recovery/[agreementId]/PaymentRecovery.tsx");
function compile(file) {
  const m = new Module(file);m.filename=file;m.paths=[path.join(root,"node_modules")];
  m.require=(name)=>name==="@/lib/installments/buyerRecoveryView"?compile(contract):name==="next/link"?
    {__esModule:true,default:({href,children,...props})=>React.createElement("a",{href,...props},children)}:nativeRequire(name);
  const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,
    target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  m._compile(code,file);return m.exports;
}
async function main(){
  const cssFile=path.join(root,"app/globals.css");
  const result=await postcss([tailwind({base:root})]).process(fs.readFileSync(cssFile,"utf8"),{from:cssFile});
  const {PaymentRecovery}=compile(component);
  const view={agreementId:"77777777-7777-4777-8777-777777777777",title:"Synthetic mentorship · CreatorNet QA",totalCents:199900,
    paymentCount:3,paymentNumber:2,amountCents:66633,outcome:"payment_method_required",observedAt:null,
    setupRequestId:null,setupState:"not_started",setupEligible:true,confirmedQuoteId:null,canSaveCard:true,canConfirmPayment:false};
  const body=renderToStaticMarkup(React.createElement(PaymentRecovery,{initial:view}));
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'"><title>CreatorNet recovery — offline visual QA</title><style>${result.css}</style></head><body>${body}</body></html>`;
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,"recovery-desktop.html"),html);
  fs.writeFileSync(path.join(output,"recovery-mobile.html"),`<!doctype html><html><head><title>CreatorNet recovery — 390px QA</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'"><style>body{margin:0;background:#242329}iframe{display:block;width:390px;height:1550px;margin:20px auto;border:1px solid #555;border-radius:18px}</style></head><body><iframe title="390px recovery preview" src="recovery-desktop.html"></iframe></body></html>`);
  process.stdout.write("Generated synthetic offline desktop and 390px previews. No server or payment client was loaded.\n");
}
main().catch(()=>{process.stderr.write("Visual QA generation failed.\n");process.exitCode=1;});
