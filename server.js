const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {Pool}=require('pg');

const PORT=process.env.PORT||8080;
const ROOT=__dirname;
const DB=process.env.DATABASE_URL;
const ADMIN_KEY=process.env.ADMIN_KEY||'dy4427574';
const TOKEN=process.env.WINGOBOT_TOKEN||'';

const pool=new Pool({
  connectionString:DB,
  ssl:DB?{rejectUnauthorized:false}:undefined
});

const send=(res,c,o)=>{
  res.writeHead(c,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store'
  });
  res.end(JSON.stringify(o));
};

const admin=req=>req.headers['x-admin-key']===ADMIN_KEY;

const body=req=>new Promise((ok,no)=>{
  let s='';
  req.on('data',x=>s+=x);
  req.on('end',()=>{
    try{
      ok(s?JSON.parse(s):{});
    }catch(e){
      no(e);
    }
  });
});

async function init(){
  if(!DB) throw Error('DATABASE_URL is not configured');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys(
      id SERIAL PRIMARY KEY,
      access_key TEXT UNIQUE NOT NULL,
      device_id TEXT,
      created_at BIGINT NOT NULL,
      last_seen BIGINT DEFAULT 0
    )
  `);
}

/* =========================
   WINGOBOT REAL HISTORY
========================= */

async function wingo(){

  if(!TOKEN){
    throw Error('WINGOBOT_TOKEN is not configured');
  }

  const r=await fetch(
    'https://api.wingobot.com/v2/30-sec-game-history',
    {
      headers:{
        Authorization:'Bearer '+TOKEN,
        Accept:'application/json'
      },
      cache:'no-store'
    }
  );

  const t=await r.text();

  let d;

  try{
    d=JSON.parse(t);
  }catch{
    throw Error(
      'WingoBot returned invalid JSON (HTTP '+r.status+')'
    );
  }

  if(!r.ok){
    throw Error(
      d.error ||
      d.message ||
      ('WingoBot API HTTP '+r.status)
    );
  }

  return d;
}

/* =========================
   CLEAN REAL HISTORY
========================= */

function hist(d){

  return (Array.isArray(d.history)?d.history:[])
    .map(x=>({
      issueNumber:x.issueNumber??null,
      number:Number(x.number),
      colour:x.colour??'',
      premium:x.premium??null,
      sum:x.sum??null
    }))
    .filter(x=>
      Number.isInteger(x.number) &&
      x.number>=0 &&
      x.number<=9
    );
}

/* =========================
   BIG / SMALL
========================= */

const bs=n=>n>=5?'BIG':'SMALL';

/* =========================
   HISTORY BASED AI ANALYSIS
========================= */

function analyze(h){

  const a=h
    .slice(0,30)
    .map(x=>x.number);

  if(a.length<3){

    return{
      prediction:null,
      number:null,
      confidence:0,
      patternScore:0,
      sampleSize:a.length,
      method:'INSUFFICIENT_HISTORY'
    };
  }

  /* Overall BIG/SMALL ratio */

  const big=
    a.filter(n=>n>=5).length/a.length;

  /* Recent 10 results */

  const recent=
    a.slice(0,10);

  const rb=
    recent.filter(n=>n>=5).length/
    recent.length;

  /* Same / flip transition */

  let same=0;
  let flip=0;

  for(let i=0;i<a.length-1;i++){

    if(bs(a[i])===bs(a[i+1])){
      same++;
    }else{
      flip++;
    }

  }

  const sr=
    (same+flip)?
    same/(same+flip):
    .5;

  /* Combined statistical score */

  let p=.5;

  p+=(big-.5)*.28;

  p+=(rb-.5)*.42;

  if(bs(a[0])==='BIG'){
    p+=(sr-.5)*.18;
  }else{
    p-=(sr-.5)*.18;
  }

  p=Math.max(
    .05,
    Math.min(.95,p)
  );

  const prediction=
    p>=.5?
    'BIG':
    'SMALL';

  /* Conservative confidence */

  const confidence=
    Math.round(
      Math.max(
        51,
        Math.min(
          82,
          50+
          (Math.max(p,1-p)-.5)*55
        )
      )
    );

  /* Number frequency */

  const cnt=
    Array(10).fill(0);

  const rec=
    Array(10).fill(0);

  a.forEach(n=>{
    cnt[n]++;
  });

  recent.forEach((n,i)=>{
    rec[n]+=
      (recent.length-i)/
      recent.length;
  });

  const cand=
    Array
      .from({length:10},(_,n)=>({
        n,
        score:
          cnt[n]*.65+
          rec[n]*.35
      }))
      .filter(x=>
        bs(x.n)===prediction
      )
      .sort(
        (x,y)=>
          y.score-x.score ||
          x.n-y.n
      );

  const number=
    cand[0]?.n ??
    (prediction==='BIG'?5:0);

  /* Pattern score */

  const patternScore=
    Math.round(
      Math.max(
        0,
        Math.min(
          100,
          50+
          Math.abs(big-.5)*70+
          Math.abs(rb-.5)*60
        )
      )
    );

  return{

    prediction,

    number,

    confidence,

    patternScore,

    sampleSize:a.length,

    latestNumber:a[0],

    latestPrediction:bs(a[0]),

    method:
      'WINGOBOT_HISTORY_STATISTICAL',

    note:
      'Historical statistical estimate only; future results are not guaranteed.'
  };
}

/* =========================
   ACCESS KEY AUTH
========================= */

async function auth(req,res){

  const key=
    String(
      req.headers['x-access-key']||''
    ).trim();

  const device=
    String(
      req.headers['x-device-id']||''
    ).trim();

  if(!key||!device){

    send(res,401,{
      success:false,
      error:'ACCESS_HEADERS_REQUIRED'
    });

    return null;
  }

  const q=
    await pool.query(
      'SELECT * FROM access_keys WHERE access_key=$1 LIMIT 1',
      [key]
    );

  if(!q.rows.length){

    send(res,401,{
      success:false,
      error:'INVALID_ACCESS_KEY'
    });

    return null;
  }

  const r=q.rows[0];

  /* Device binding */

  if(
    r.device_id &&
    r.device_id!==device
  ){

    send(res,403,{
      success:false,
      error:'KEY_BOUND_TO_ANOTHER_DEVICE'
    });

    return null;
  }

  await pool.query(
    `
    UPDATE access_keys
    SET
      device_id=COALESCE(device_id,$1),
      last_seen=$2
    WHERE id=$3
    `,
    [
      device,
      Date.now(),
      r.id
    ]
  );

  return r;
}

/* =========================
   MAIN SERVER
========================= */

async function handle(req,res){

  const u=
    new URL(
      req.url,
      'http://localhost'
    );

  /* CORS */

  if(req.method==='OPTIONS'){

    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':
        'Content-Type,X-Admin-Key,X-Access-Key,X-Device-ID',
      'Access-Control-Allow-Methods':
        'GET,POST,DELETE,OPTIONS'
    });

    return res.end();
  }

  /* =========================
     HEALTH
  ========================= */

  if(
    (u.pathname==='/health' ||
     u.pathname==='/api/health')
  ){

    return send(res,200,{
      success:true,
      ok:true,
      service:'DY AI Wingo 30S'
    });
  }

  /* =========================
     ADMIN PING
  ========================= */

  if(
    u.pathname==='/api/admin/ping' &&
    req.method==='GET'
  ){

    if(!admin(req))
      return send(res,401,{
        success:false,
        error:'UNAUTHORIZED'
      });

    return send(res,200,{
      success:true
    });
  }

  /* =========================
     ADMIN STATUS
  ========================= */

  if(
    u.pathname==='/api/admin/status' &&
    req.method==='GET'
  ){

    if(!admin(req))
      return send(res,401,{
        success:false,
        error:'UNAUTHORIZED'
      });

    let db=false;

    try{
      await pool.query('SELECT 1');
      db=true;
    }catch{}

    return send(res,200,{
      success:true,
      database:db,
      wingobot:!!TOKEN,
      uptime:process.uptime()
    });
  }

  /* =========================
     GET ADMIN KEYS
  ========================= */

  if(
    u.pathname==='/api/admin/keys' &&
    req.method==='GET'
  ){

    if(!admin(req))
      return send(res,401,{
        success:false,
        error:'UNAUTHORIZED'
      });

    const q=
      await pool.query(
        `
        SELECT
          id,
          access_key,
          device_id,
          created_at,
          last_seen
        FROM access_keys
        ORDER BY id DESC
        `
      );

    return send(res,200,{
      success:true,

      keys:q.rows.map(x=>({

        ...x,

        key:x.access_key,

        live:
          Date.now()-
          Number(x.last_seen||0)
          <=90000 &&
          Number(x.last_seen||0)>0

      }))
    });
  }

  /* =========================
     CREATE ACCESS KEY
  ========================= */

  if(
    u.pathname==='/api/admin/keys' &&
    req.method==='POST'
  ){

    if(!admin(req))
      return send(res,401,{
        success:false,
        error:'UNAUTHORIZED'
      });

    const b=await body(req);

    const k=
      String(
        b.key ??
        b.access_key ??
        b.customKey ??
        ''
      ).trim()
      ||
      (
        'DY-USER-'+
        crypto
          .randomBytes(5)
          .toString('hex')
          .toUpperCase()
      );

    try{

      const q=
        await pool.query(
          `
          INSERT INTO access_keys
          (
            access_key,
            created_at,
            last_seen
          )
          VALUES($1,$2,0)
          RETURNING *
          `,
          [
            k,
            Date.now()
          ]
        );

      return send(res,200,{
        success:true,
        key:k,
        access_key:k,
        item:q.rows[0]
      });

    }catch(e){

      if(e.code==='23505'){

        return send(res,409,{
          success:false,
          error:'KEY_ALREADY_EXISTS'
        });
      }

      throw e;
    }
  }

  /* =========================
     DELETE ACCESS KEY
  ========================= */

  if(
    u.pathname==='/api/admin/keys' &&
    req.method==='DELETE'
  ){

    if(!admin(req))
      return send(res,401,{
        success:false,
        error:'UNAUTHORIZED'
      });

    const b=await body(req);

    const k=
      String(
        b.key ??
        b.access_key ??
        ''
      ).trim();

    await pool.query(
      'DELETE FROM access_keys WHERE access_key=$1',
      [k]
    );

    return send(res,200,{
      success:true
    });
  }

  /* =========================
     RESET DEVICE
  ========================= */

  if(
    u.pathname==='/api/admin/reset-device' &&
    req.method==='POST'
  ){

    if(!admin(req))
      return send(res,401,{
        success:false,
        error:'UNAUTHORIZED'
      });

    const b=await body(req);

    if(b.id){

      await pool.query(
        `
        UPDATE access_keys
        SET
          device_id=NULL,
          last_seen=0
        WHERE id=$1
        `,
        [Number(b.id)]
      );

    }else{

      await pool.query(
        `
        UPDATE access_keys
        SET
          device_id=NULL,
          last_seen=0
        WHERE access_key=$1
        `,
        [
          String(b.key||'')
        ]
      );
    }

    return send(res,200,{
      success:true
    });
  }

  /* =========================
     TEST WINGOBOT API
  ========================= */

  if(
    u.pathname==='/api/admin/wingo-test' &&
    req.method==='GET'
  ){

    if(!admin(req))
      return send(res,401,{
        success:false,
        error:'UNAUTHORIZED'
      });

    try{

      const d=await wingo();

      return send(res,200,{

        success:true,

        source:'WingoBot',

        current:
          d.current||null,

        history:
          hist(d).slice(0,20),

        stats:
          d.stats||null

      });

    }catch(e){

      console.error(
        'WINGOBOT TEST ERROR:',
        e.message
      );

      return send(res,502,{

        success:false,

        error:
          'WINGOBOT_API_FAILED',

        message:
          e.message

      });
    }
  }

  /* =========================
     CHECK ACCESS KEY
  ========================= */

  if(
    u.pathname==='/api/key/check' &&
    req.method==='GET'
  ){

    const r=
      await auth(req,res);

    if(!r)return;

    return send(res,200,{

      success:true,

      valid:true,

      status:
        r.device_id?
        'LIVE':
        'UNBOUND',

      key:
        r.access_key

    });
  }

  /* =========================
     REAL AI STATE
  ========================= */

  if(
    u.pathname==='/api/state' &&
    req.method==='GET'
  ){

    const r=
      await auth(req,res);

    if(!r)return;

    try{

      /* REAL WINGOBOT DATA */

      const d=
        await wingo();

      const h=
        hist(d);

      /* AI ANALYSIS */

      const a=
        analyze(h);

      const cur=
        d.current||{};

      const currentNumber=
        Number.isInteger(
          Number(cur.number)
        )
        ?
        Number(cur.number)
        :
        (
          h[0]?.number ??
          null
        );

      const currentIssue=
        cur.issueNumber ??
        h[0]?.issueNumber ??
        null;

      return send(res,200,{

        success:true,

        source:
          'WingoBot',

        realHistory:
          true,

        current:{

          issueNumber:
            currentIssue,

          number:
            currentNumber

        },

        period:
          currentIssue,

        prediction:
          a.prediction,

        number:
          a.number,

        confidence:
          a.confidence,

        patternScore:
          a.patternScore,

        sampleSize:
          a.sampleSize,

        method:
          a.method,

        history:
          h.slice(0,20),

        stats:
          d.stats||null,

        note:
          a.note

      });

    }catch(e){

      console.error(
        'STATE WINGOBOT ERROR:',
        e.message
      );

      return send(res,502,{

        success:false,

        source:
          'WingoBot',

        realHistory:
          false,

        error:
          'WINGOBOT_API_FAILED',

        message:
          e.message

      });
    }
  }

  /* =========================
     REAL HISTORY ENDPOINT
  ========================= */

  if(
    u.pathname==='/api/history' &&
    req.method==='GET'
  ){

    const r=
      await auth(req,res);

    if(!r)return;

    try{

      const d=
        await wingo();

      return send(res,200,{

        success:true,

        source:
          'WingoBot',

        history:
          hist(d).slice(0,30),

        current:
          d.current||null,

        stats:
          d.stats||null

      });

    }catch(e){

      return send(res,502,{

        success:false,

        error:
          'WINGOBOT_API_FAILED',

        message:
          e.message

      });
    }
  }

  /* =========================
     STATIC FILES
  ========================= */

  let file;

  if(
    u.pathname==='/' ||
    u.pathname==='/prediction.html'
  ){

    file='prediction.html';

  }else if(
    u.pathname==='/admin' ||
    u.pathname==='/admin.html'
  ){

    file='admin.html';

  }else if(
    u.pathname==='/music.mp3'
  ){

    file='music.mp3';

  }else{

    file=
      u.pathname.replace(
        /^\//,
        ''
      );
  }

  file=
    path.join(
      ROOT,
      file
    );

  /* Path protection */

  if(!file.startsWith(ROOT)){

    return send(res,403,{
      success:false,
      error:'FORBIDDEN'
    });
  }

  fs.stat(
    file,
    (e,s)=>{

      if(e||!s.isFile()){

        return send(res,404,{
          success:false,
          error:'NOT_FOUND'
        });
      }

      const ext=
        path.extname(file)
        .toLowerCase();

      const types={

        '.html':
          'text/html; charset=utf-8',

        '.css':
          'text/css; charset=utf-8',

        '.js':
          'application/javascript; charset=utf-8',

        '.json':
          'application/json; charset=utf-8',

        '.png':
          'image/png',

        '.jpg':
          'image/jpeg',

        '.jpeg':
          'image/jpeg',

        '.svg':
          'image/svg+xml',

        '.mp3':
          'audio/mpeg'
      };

      /* MP3 range support */

      if(
        ext==='.mp3' &&
        req.headers.range
      ){

        const range=
          req.headers.range.match(
            /bytes=(\d+)-(\d*)/
          );

        if(!range){

          res.writeHead(416);

          return res.end();
        }

        const start=
          Number(range[1]);

        const end=
          range[2]
          ?
          Number(range[2])
          :
          s.size-1;

        if(
          start>=s.size ||
          start>end
        ){

          res.writeHead(
            416,
            {
              'Content-Range':
                `bytes */${s.size}`
            }
          );

          return res.end();
        }

        const safeEnd=
          Math.min(
            end,
            s.size-1
          );

        res.writeHead(
          206,
          {

            'Content-Type':
              'audio/mpeg',

            'Content-Range':
              `bytes ${start}-${safeEnd}/${s.size}`,

            'Accept-Ranges':
              'bytes',

            'Content-Length':
              safeEnd-start+1,

            'Cache-Control':
              'public, max-age=3600'
          }
        );

        return fs
          .createReadStream(
            file,
            {
              start,
              end:safeEnd
            }
          )
          .pipe(res);
      }

      res.writeHead(
        200,
        {
          'Content-Type':
            types[ext] ||
            'application/octet-stream',

          'Cache-Control':
            ext==='.mp3'
            ?
            'public, max-age=3600'
            :
            'no-store'
        }
      );

      fs
        .createReadStream(file)
        .pipe(res);
    }
  );
}

/* =========================
   START SERVER
========================= */

(async()=>{

  try{

    await init();

    http
      .createServer(
        (req,res)=>{

          handle(
            req,
            res
          ).catch(e=>{

            console.error(
              'SERVER ERROR:',
              e
            );

            if(!res.headersSent){

              send(
                res,
                500,
                {
                  success:false,
                  error:
                    e.message
                }
              );

            }else{

              res.end();

            }
          });
        }
      )
      .listen(
        PORT,
        ()=>{
          console.log(
            'DY AI WINGO 30S ONLINE '+PORT
          );
        }
      );

  }catch(e){

    console.error(
      'STARTUP ERROR:',
      e
    );

    process.exit(1);
  }

})();
