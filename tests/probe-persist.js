const http=require("http"),fs=require("fs"),path=require("path");
const puppeteer=require("puppeteer-core");
const ROOT=path.join(__dirname,".."),PORT=8892;
const MOCK=fs.readFileSync(path.join(__dirname,"mock-transport.js"),"utf8");
const MIME={".html":"text/html",".js":"text/javascript",".css":"text/css"};
http.createServer((q,s)=>{
  const p=q.url==="/__shell.html"?path.join(__dirname,"shell.html"):path.join(ROOT,q.url==="/"?"index.html":decodeURIComponent(q.url.split("?")[0]));
  fs.readFile(p,(e,d)=>{if(e){s.writeHead(404);s.end();return}
    s.writeHead(200,{"Content-Type":MIME[path.extname(p)]||"text/plain","Cache-Control":"public, max-age=31536000"});s.end(d)});
}).listen(PORT,"127.0.0.1",async()=>{
 const b=await puppeteer.launch({executablePath:"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
 const page=await b.newPage();
 const cdp=await page.createCDPSession();await cdp.send("Network.enable");
 await cdp.send("Network.setBlockedURLs",{urls:["*supabase.min.js*","*googletagmanager.com*","*google-analytics.com*","*fonts.googleapis.com*","*fonts.gstatic.com*"]});
 page.on("console",m=>console.log("[pg]",m.type(),m.text().slice(0,140)));
 page.on("pageerror",e=>console.log("[pageerror]",e.message.slice(0,200)));
 await page.evaluateOnNewDocument(MOCK);
 await page.goto(`http://127.0.0.1:${PORT}/__shell.html`,{waitUntil:"domcontentloaded"});
 await page.waitForFunction(()=>window.frames.length>=2&&Array.from(window.frames).every(f=>f.document.getElementById("welcome-screen")));
 let [A,B]=page.frames().filter(f=>f.url().endsWith("/"));

 const enter=async(f,n)=>{await f.evaluate(v=>{document.getElementById("name-input").value=v;document.getElementById("start-button").click()},n);
   await f.waitForFunction(()=>document.getElementById("connection-text").textContent==="Connected",{timeout:8000});};
 await enter(A,"Alice");await enter(B,"Bob");

 await A.evaluate(()=>{document.getElementById("private-chat-tab").click();document.getElementById("create-room-button").click()});
 await A.waitForFunction(()=>/^Room \d{4}$/.test(document.getElementById("room-title").textContent));
 const codeX=await A.$eval("#room-code-label",el=>el.textContent.trim());
 await B.evaluate(c=>{document.getElementById("private-chat-tab").click();document.getElementById("room-code-input").value=c;document.getElementById("join-room-button").click()},codeX);
 await B.waitForFunction(()=>document.getElementById("room-status").dataset.state==="connected",{timeout:5000});
 console.log("[flow] room X",codeX,"bob subscribed");

 // Alice leaves chat entirely, then re-enters (same document).
 await A.evaluate(()=>document.getElementById("leave-button").click());
 await new Promise(r=>setTimeout(r,600));
 await A.evaluate(()=>{document.getElementById("name-input").value="Alice";document.getElementById("start-button").click()});
 await A.waitForFunction(()=>document.getElementById("connection-text").textContent==="Connected",{timeout:8000});

 await A.evaluate(()=>{document.getElementById("private-chat-tab").click();document.getElementById("create-room-button").click()});
 await A.waitForFunction(()=>/^Room \d{4}$/.test(document.getElementById("room-title").textContent));
 const code=await A.$eval("#room-code-label",el=>el.textContent.trim());
 await B.evaluate(c=>{document.getElementById("room-code-input").value=c;document.getElementById("join-room-button").click()},code);
 await B.waitForFunction(()=>document.getElementById("room-status").dataset.state==="connected",{timeout:5000});
 console.log("[flow] room Y",code,"bob joined (while still in X)");

 await A.evaluate(()=>{document.getElementById("private-message-input").value="seed one"});
 await A.evaluate(()=>document.getElementById("private-send-button").click());
 await new Promise(r=>setTimeout(r,800));
 const bobState=await B.evaluate(()=>({rooms:Array.from(privateRooms.entries()).map(([k,r])=>`${k}:sub${r.subscribed?1:0},key${r.key?1:0},rows${r.listRows.length}`),rows:document.querySelectorAll("#private-message-list .private-message-row").length,active:activeRoomCode,mode:currentMode}));
 console.log("[flow] bob after seed:",JSON.stringify(bobState));

 // Soft reload alice
 await A.evaluate(()=>setTimeout(()=>location.reload(),0)).catch(()=>{});
 await new Promise(r=>setTimeout(r,2000));
 const frames=page.frames().filter(f=>f.url().endsWith("/"));
 for(const f of frames){const t=await f.evaluate(()=>window.frameElement?.id).catch(()=>"?");
   if(t==="client-a")A=f;}
 console.log("[flow] alice post-reload state:",JSON.stringify(await A.evaluate(()=>({
   welcomeHidden:document.getElementById("welcome-screen").classList.contains("hidden"),
   conn:document.getElementById("connection-text").textContent,
   rooms:Array.from(privateRooms.entries()).map(([k,r])=>`${k}:sub${r.subscribed?1:0},key${r.key?1:0},rows${r.listRows.length},salt${r.saltB64?"y":"n"}`),
   ss:!!sessionStorage.getItem("globchat.session.v1")})).catch(e=>({err:e.message}))));
 await b.close().catch(()=>{});process.exit(0);
});
