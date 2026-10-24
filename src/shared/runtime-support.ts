/** Admission before application data access; no fallback for missing transaction state. */
import {createRequire} from 'node:module';
import type {DatabaseSync as Database} from 'node:sqlite';

const require=createRequire(import.meta.url);
const range=(require('../../package.json') as {engines:{node:string}}).engines.node;
function refuse(code:string,detail:string):never{
 throw Object.assign(new Error(`Cannot start: ${detail}. Supported Node.js versions: ${range}. Install a maintained patch in a supported range (or update the desktop build), then run npm run runtime:check before retrying. Application databases have not been opened by this check.`),{code});
}
type NodeVersion=[major:number,minor:number,patch:number];
const parts=(version:string):NodeVersion|null=>/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)?version.split('.').map(Number) as NodeVersion:null;
const version=parts(process.versions.node);
const floors=range.split(' || ').map(value=>value.startsWith('^')?parts(value.slice(1)):null);
// This policy deliberately supports explicit caret ranges on named, nonzero Node majors.
// Reject an unrecognized policy rather than guessing at npm's general semver grammar.
if(!floors.length||floors.some(f=>!f||!f[0]||!f.every(Number.isSafeInteger)))refuse('UNSUPPORTED_NODE_RUNTIME','the configured Node.js support policy is invalid');
if(!version||!version.every(Number.isSafeInteger)||!floors.some(f=>f&&version[0]===f[0]&&(version[1]>f[1]||version[1]===f[1]&&version[2]>=f[2])))
 refuse('UNSUPPORTED_NODE_RUNTIME',`Node.js ${process.versions.node} is not a qualified runtime`);

// Check compiled SQLite capabilities in private memory, never on a tenant/catalog handle.
let probe:Database|undefined,session:ReturnType<Database['createSession']>|undefined;
try{
 const {DatabaseSync}=require('node:sqlite') as typeof import('node:sqlite');
 probe=new DatabaseSync(':memory:');
 if(probe.isTransaction!==false)throw new Error('SQLite transaction-state API is missing or incorrect');
 probe.exec('BEGIN');
 if((probe.isTransaction as boolean)!==true)throw new Error('SQLite does not report an open transaction');
 probe.exec('ROLLBACK');
 if(probe.isTransaction!==false)throw new Error('SQLite does not report a completed rollback');
 probe.exec("CREATE VIRTUAL TABLE runtime_search USING fts5(value); INSERT INTO runtime_search VALUES('admission');");
 if((probe.prepare("SELECT COUNT(*) AS n FROM runtime_search WHERE runtime_search MATCH 'admission'").get() as {n:number}).n!==1)
  throw new Error('SQLite FTS5 is unavailable');
 if(typeof probe.createSession!=='function'||typeof probe.applyChangeset!=='function')throw new Error('SQLite session APIs are unavailable');
 probe.exec('CREATE TABLE runtime_rows(id INTEGER PRIMARY KEY,value TEXT)');
 session=probe.createSession();probe.exec("INSERT INTO runtime_rows VALUES(1,'admission')");
 if(!session.changeset().byteLength)throw new Error('SQLite session capture is unavailable');
}catch(error){refuse('UNSUPPORTED_SQLITE_RUNTIME',`SQLite runtime capabilities are unavailable: ${(error as Error).message}`);}
finally{try{session?.close();}finally{probe?.close();}}
