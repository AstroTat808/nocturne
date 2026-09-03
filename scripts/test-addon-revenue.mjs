import fs from 'node:fs';
const backend=fs.readFileSync('netlify/functions/admin-row-entitlements.mjs','utf8');
const client=fs.readFileSync('site/assets/js/admin-drinks.js','utf8');
const failures=[];const has=(source,value,message)=>{if(!source.includes(value))failures.push(message)};
has(backend,"import { drinkPackageConfig }",'Revenue must use configured Six-Drink pricing.');
has(backend,"import { waterPackageConfig }",'Revenue must use configured Water pricing.');
has(backend,"import { lateStayConfig }",'Revenue must use configured Late Stay pricing.');
has(backend,'drinkPackageRevenueCents','Six-Drink revenue must be summarized.');
has(backend,'waterPackageRevenueCents','Water revenue must be summarized.');
has(backend,'lateStayRevenueCents','Late Stay revenue must be summarized.');
has(backend,'counts.packageRevenueCents +=','All paid add-on revenue must roll into Package Revenue.');
has(backend,"purchaseType === 'addon' ? checkoutStatus === 'paid'",'Standalone add-ons must require paid checkout status.');
has(backend,"['paid', 'checked_in'].includes(ticketStateValue)",'Bundled add-ons must require a paid/checked-in admission record.');
has(client,"revenue.textContent=money(summary.packageRevenueCents||0)",'Admin UI must render authoritative entitlement revenue.');
has(client,"cache:'no-store'",'Admin entitlement/revenue refresh must bypass browser cache.');
if(failures.length){console.error('Add-on revenue regression checks failed:');for(const failure of failures)console.error(`- ${failure}`);process.exit(1)}
console.log('Add-on revenue regression checks passed.');
