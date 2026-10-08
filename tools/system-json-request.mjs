import { spawn } from 'node:child_process';

// Pass credentials over stdin, never command-line arguments or files.
export async function systemJsonRequest(request) {
  const output=await new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $venueRequest=[Console]::In.ReadToEnd() | ConvertFrom-Json; $venueHeaders=@{}; $venueRequest.headers.psobject.Properties | ForEach-Object { $venueHeaders[$_.Name]=$_.Value }; try { $venueParams=@{Uri=$venueRequest.url;Method=$venueRequest.method;Headers=$venueHeaders;UseBasicParsing=$true;TimeoutSec=50}; if ($venueRequest.body) { $venueParams.ContentType='application/json'; $venueParams.Body=[System.Text.Encoding]::UTF8.GetBytes($venueRequest.body) }; $venueResponse=Invoke-WebRequest @venueParams; if ($venueResponse.Content -is [byte[]]) { [Console]::Write([System.Text.Encoding]::UTF8.GetString($venueResponse.Content)) } else { [Console]::Write($venueResponse.Content) } } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }"],
      {stdio:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk});
    child.on('error',reject);child.on('close',code=>code===0?resolve(stdout):reject(Error(`System HTTPS request failed: ${stderr.slice(0,250)}`)));
    child.stdin.end(JSON.stringify(request));
  });
  return output ? JSON.parse(output) : null;
}
