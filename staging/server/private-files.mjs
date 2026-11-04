import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';

const execute=promisify(execFile),windowsRoots=new Set();
const denied=()=>Object.assign(Error('Répertoire privé Ludy indisponible.'),{code:'PRIVATE_STORAGE_UNAVAILABLE'});
// PowerShell 7 -> Node -> Windows PowerShell 5.1 otherwise inherits PS7 module
// paths, so Set-Acl may resolve to an incompatible Security module. Let the
// Windows PowerShell child construct its own defaults; don't modify the parent.
export function windowsPowerShellEnvironment(environment=process.env){
  return Object.fromEntries(Object.entries(environment).filter(([key])=>key.toLowerCase()!=='psmodulepath'));
}
// Fixed script: the filesystem path is passed as a single environment value,
// never interpolated into PowerShell code. Replace the root ACL, don't merely
// remove inherited entries while retaining older explicit permissions.
export const WINDOWS_PRIVATE_ACL_SCRIPT=`$ErrorActionPreference = 'Stop'
$directory = $env:LUDY_PRIVATE_DIRECTORY
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
foreach ($identity in @($owner, $system)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$acl.SetOwner($owner)
Set-Acl -LiteralPath $directory -AclObject $acl
`;
const windowsPath=value=>path.win32.resolve(value).toLowerCase();
function inWindowsRoot(filename){
  if(typeof filename!=='string'||!path.win32.isAbsolute(filename))return false;
  const candidate=windowsPath(filename);
  return [...windowsRoots].some(root=>{const relative=path.win32.relative(root,candidate);return relative===''||relative!=='..'&&!relative.startsWith('..\\')&&!path.win32.isAbsolute(relative);});
}
export async function initializePrivateRoot(directory,{platform=process.platform,files=fs,run=execute}={}) {
  const paths=platform==='win32'?path.win32:path;
  if(typeof directory!=='string'||!paths.isAbsolute(directory)||paths.resolve(directory)===paths.parse(directory).root)throw denied();
  const root=paths.resolve(directory);
  await files.mkdir(root,{recursive:true,mode:0o700});
  const info=await files.lstat(root),canonical=await files.realpath(root);
  if(!info.isDirectory()||info.isSymbolicLink()||(platform==='win32'?windowsPath(canonical)!==windowsPath(root):canonical!==root))throw denied();
  if(platform==='win32') {
    try{await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',WINDOWS_PRIVATE_ACL_SCRIPT],{env:{...windowsPowerShellEnvironment(),LUDY_PRIVATE_DIRECTORY:root},windowsHide:true,timeout:20000,maxBuffer:8192});}
    catch{throw denied();}
    windowsRoots.add(windowsPath(root));
  } else {await files.chmod(root,0o700);if(((await files.lstat(root)).mode&0o777)!==0o700)throw denied();}
  return {directory:root,protection:platform==='win32'?'windows-user-system-acl':'posix-0700'};
}
export function privateModeValid(stat,expected,filename,{platform=process.platform}={}) {
  if(platform==='win32')return inWindowsRoot(filename);
  return (stat.mode&0o777)===expected;
}
export async function syncPrivateDirectory(directory,{platform=process.platform,files=fs}={}) {
  if(platform==='win32') {
    if(!inWindowsRoot(directory))throw denied();
    // Windows cannot fsync a directory through Node. Atomic rename and the
    // already completed file-handle sync remain; power-loss durability of the
    // directory entry is not claimed to be equivalent to POSIX directory fsync.
    return;
  }
  const handle=await files.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await handle.sync();}finally{await handle.close();}
}
export async function ensurePrivateDirectory(directory) {
  if(!path.isAbsolute(directory))throw denied();
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const info=await fs.lstat(directory),resolved=await fs.realpath(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||(process.platform==='win32'?windowsPath(resolved)!==windowsPath(directory):resolved!==path.resolve(directory)))throw denied();
  if(process.platform==='win32'){if(!privateModeValid(info,0o700,directory))throw denied();}
  else await fs.chmod(directory,0o700);
}
export async function readPrivateJson(filename,{maxBytes=131072,missing=null}={}) {
  let file;
  try{
    const before=await fs.lstat(filename);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!privateModeValid(before,0o600,filename)||before.size>maxBytes)throw denied();
    if(process.platform==='win32'&&windowsPath(await fs.realpath(filename))!==windowsPath(filename))throw denied();
    file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||!privateModeValid(stat,0o600,filename)||stat.size>maxBytes)throw denied();
    const bytes=await file.readFile();if(bytes.length>maxBytes)throw denied();return JSON.parse(bytes.toString('utf8'));
  }catch(error){if(error.code==='ENOENT')return missing;throw denied();}finally{await file?.close();}
}
export async function writePrivateJson(filename,value,{maxBytes=131072}={}) {
  const directory=path.dirname(filename),bytes=JSON.stringify(value)+'\n';
  if(Buffer.byteLength(bytes)>maxBytes)throw denied();
  await ensurePrivateDirectory(directory);
  try{const existing=await fs.lstat(filename);if(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1)throw denied();}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=filename+'.'+randomUUID()+'.tmp';let file;
  try{
    file=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await file.writeFile(bytes);await file.sync();await file.close();file=null;
    await fs.rename(temporary,filename);await syncPrivateDirectory(directory);
  }finally{await file?.close();await fs.rm(temporary,{force:true}).catch(()=>{});}
}
