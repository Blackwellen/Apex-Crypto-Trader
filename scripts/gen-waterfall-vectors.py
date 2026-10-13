import random, subprocess, json
random.seed(7)
def mk(gross,deficit,tax,rv,vt,cx,rs,minT): return dict(gross=gross,deficit=deficit,tax=tax,rv=rv,vt=vt,cx=cx,rs=rs,minTicket=minT)
cases=[mk(1,0,0,10000,0,0,0,0),mk(1,0,0,0,10000,0,0,0),mk(7,0,0,3333,3333,3334,0,0),mk(999999,0,1000,4000,3500,0,2500,0),mk(10**30+7,0,1234,3333,3333,3334,0,0),mk(100,0,10000,0,0,0,0,0),mk(5,0,3,1,1,0,9998,0),
 mk(1000,300,500,4000,3500,0,2500,0),mk(1000,2000,500,4000,3500,0,2500,0),mk(1000,0,0,10000,0,0,0,2000),mk(0,0,0,10000,0,0,0,0)]
for _ in range(60):
    parts=sorted(random.sample(range(0,10001),3)); rv,vt,cx,rs=parts[0],parts[1]-parts[0],parts[2]-parts[1],10000-parts[2]
    cases.append(mk(random.choice([random.randint(1,10**6),random.randint(1,10**20)]),random.choice([0,0,random.randint(0,10**5)]),random.randint(0,10000),rv,vt,cx,rs,random.choice([0,0,random.randint(0,10**4)])))
out=[]
for c in cases:
    q=f"""with p as (select {c['gross']}::numeric g, {c['deficit']}::numeric d, {c['tax']} tx, {c['vt']} vtb, {c['cx']} cxb, {c['rs']} rsb, {c['minTicket']}::numeric mt),
    s as (select least(d,g) def, g-least(d,g) elig, p.* from p)
    select case when g=0 then 'none' when elig<mt or elig=0 then 'skip' else 'ok' end, def, elig,
     div(elig*tx,10000), div((elig-div(elig*tx,10000))*vtb,10000), div((elig-div(elig*tx,10000))*cxb,10000), div((elig-div(elig*tx,10000))*rsb,10000) from s"""
    r=subprocess.check_output(['psql','postgres://postgres@localhost:54329/apex','-Atq','-F','|','-c',q]).decode().strip().split('|')
    kind,def_,elig,tax,vt,cx,rs=r
    if kind=='ok': e=dict(deficitRecovered=def_,eligible=elig,tax=tax,vault=vt,cross=cx,reserve=rs,reinvest=str(int(elig)-int(tax)-int(vt)-int(cx)-int(rs)))
    elif kind=='skip': e=dict(deficitRecovered=def_,eligible='0',tax='0',vault='0',cross='0',reserve='0',reinvest='0')
    else: e=dict(deficitRecovered='0',eligible='0',tax='0',vault='0',cross='0',reserve='0',reinvest='0')
    out.append(dict(input={k:str(v) if k in('gross','deficit','minTicket') else v for k,v in c.items()},expected=e))
json.dump(out,open('lib/waterfall.sql-vectors.json','w'),indent=0); print(len(out))
