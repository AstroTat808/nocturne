import { privateVenue, privateVenueConfigured } from './_venue.mjs';

const REQUIRED_ENV = ['NOCTURNE_APPLE_PASS_TYPE_ID','NOCTURNE_APPLE_TEAM_ID'];
function certificatePresent(name){return Boolean(process.env[`${name}_BASE64`]||process.env[`${name}_PEM`]);}
export function appleWalletStatus(){const fields={passTypeIdentifier:Boolean(process.env.NOCTURNE_APPLE_PASS_TYPE_ID),teamIdentifier:Boolean(process.env.NOCTURNE_APPLE_TEAM_ID),privateVenue:privateVenueConfigured(),wwdrCertificate:certificatePresent('NOCTURNE_APPLE_WWDR_CERT'),signerCertificate:certificatePresent('NOCTURNE_APPLE_PASS_CERT'),signerKey:certificatePresent('NOCTURNE_APPLE_PASS_KEY')};return{configured:Object.values(fields).every(Boolean),fields};}
export function appleWalletConfigured(){return appleWalletStatus().configured;}
function certificateBuffer(name){const encoded=String(process.env[`${name}_BASE64`]||'').trim();if(encoded)return Buffer.from(encoded,'base64');const pem=String(process.env[`${name}_PEM`]||'').replaceAll('\\n','\n').trim();return pem?Buffer.from(`${pem}\n`):null;}
export function appleWalletCertificates(){if(!appleWalletConfigured())return null;return{wwdr:certificateBuffer('NOCTURNE_APPLE_WWDR_CERT'),signerCert:certificateBuffer('NOCTURNE_APPLE_PASS_CERT'),signerKey:certificateBuffer('NOCTURNE_APPLE_PASS_KEY'),...(process.env.NOCTURNE_APPLE_PASS_KEY_PASSPHRASE?{signerKeyPassphrase:process.env.NOCTURNE_APPLE_PASS_KEY_PASSPHRASE}:{})};}

export function buildAppleWalletPass({ticketId,guestName,ticketName,ticketUrl,manageAddonsUrl='',waiverUrl='',waiverSigned=false,checkedIn=false,drinkPackage=null}){
  for(const name of REQUIRED_ENV){if(!process.env[name])throw new Error(`${name} is not configured.`);}
  if(!privateVenueConfigured())throw new Error('Private venue is not configured.');
  const venue=privateVenue();
  const packageStatus=drinkPackage?.purchased?`${Number(drinkPackage.remaining||0)} of ${Number(drinkPackage.purchasedCredits||6)} credits remaining`:'Not included';
  const backFields=[
    {key:'ticketId',label:'Ticket ID',value:ticketId},
    {key:'guestName',label:'Registered Guest',value:guestName||'NOCTURNE Guest'},
    {key:'venue',label:'Private Venue',value:`${venue.name}\n${venue.address}`},
    {key:'drinkPackage',label:'Six-Drink Package',value:packageStatus},
    {key:'waiver',label:'Required Waiver',value:waiverSigned?'SIGNED — gate ready':'NOT SIGNED — required before entry'},
    ...(manageAddonsUrl?[{key:'manageAddons',label:'Buy / Manage Add-Ons',value:manageAddonsUrl,attributedValue:`<a href="${manageAddonsUrl}">Open Manage Add-Ons</a>`}]:[]),
    ...(!waiverSigned&&waiverUrl?[{key:'signWaiver',label:'Sign Required Waiver',value:waiverUrl,attributedValue:`<a href="${waiverUrl}">Sign Waiver Before Entry</a>`}]:[]),
    {key:'entry',label:'Entry',value:'Present the QR code and matching identification at event check-in. A signed individual participant waiver is required before entry. This ticket is personal, revocable, and valid only while the underlying NOCTURNE order remains active.'},
    {key:'privacy',label:'Private Event',value:'Do not post or share the private venue address or ticket QR code.'},
    {key:'support',label:'Support',value:process.env.NOCTURNE_HELP_EMAIL||'help@nocturnefestival.com'}
  ];
  return{
    formatVersion:1,passTypeIdentifier:process.env.NOCTURNE_APPLE_PASS_TYPE_ID,teamIdentifier:process.env.NOCTURNE_APPLE_TEAM_ID,organizationName:'Wild Ones LLC',description:'NOCTURNE Festival digital admission ticket',serialNumber:ticketId,groupingIdentifier:'nocturne-festival-2026',logoText:'NOCTURNE',foregroundColor:'rgb(247, 239, 227)',backgroundColor:'rgb(3, 3, 3)',labelColor:'rgb(216, 154, 43)',relevantDate:'2026-09-06T15:00:00-10:00',relevantDates:[{startDate:'2026-09-06T15:00:00-10:00',endDate:'2026-09-07T03:00:00-10:00'}],expirationDate:'2026-09-07T10:00:00-10:00',sharingProhibited:true,
    barcodes:[{format:'PKBarcodeFormatQR',message:ticketUrl,messageEncoding:'iso-8859-1',altText:ticketId}],
    eventTicket:{headerFields:[{key:'admission',label:'ADMISSION',value:checkedIn?'CHECKED IN':waiverSigned?'VALID':'WAIVER REQUIRED'}],primaryFields:[{key:'event',label:'FESTIVAL',value:ticketName||'NOCTURNE Festival'}],secondaryFields:[{key:'date',label:'DATE',value:'SUN · SEP 6, 2026'},{key:'time',label:'TIME',value:'3:00 PM – 3:00 AM'}],auxiliaryFields:[{key:'guest',label:'GUEST',value:guestName||'NOCTURNE Guest'},{key:'location',label:'VENUE',value:venue.name}],backFields}
  };
}
