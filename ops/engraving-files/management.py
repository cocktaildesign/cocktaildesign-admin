#!/usr/bin/env python3
"""Private engraving storage maintenance. No shop DB, network, CRM, or notifications.

Committed files are never deleted by cleanup. Archive deletion requires an exact
verified snapshot plus an explicit list of completed order files and its SHA256.
"""
import argparse, contextlib, datetime, hashlib, json, os, re, shutil, sqlite3, tarfile, tempfile, time
from pathlib import Path

ID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()
def storage(root):
    root=Path(root)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir(): raise ValueError('Invalid storage root')
    root=root.resolve()
    if not (root/'metadata.sqlite').is_file(): raise ValueError('Storage not initialized')
    return root
def blob(root,id):
    if not ID.fullmatch(id): raise ValueError('Invalid file ID')
    p=root/'blobs'/id
    if p.is_symlink() or p.resolve().parent != (root/'blobs').resolve(): raise ValueError('Invalid file path')
    return p
@contextlib.contextmanager
def connection(root):
    db=sqlite3.connect(root/'metadata.sqlite',timeout=10);db.row_factory=sqlite3.Row
    try: yield db
    finally: db.close()
@contextlib.contextmanager
def lock(root):
    # Linux systemd maintenance/archival mutual exclusion; not used by HTTP reads.
    import fcntl
    with open(root/'.maintenance.lock','a') as f:
        os.chmod(f.name,0o600);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield
def cleanup(root):
    now=time.time()*1000
    with connection(root) as db:
        db.execute('BEGIN IMMEDIATE')
        rows=db.execute("SELECT id FROM files WHERE (state='ready' AND created<?) OR (state='receiving' AND created<?)",(now-7*86400000,now-3600000)).fetchall()
        for row in rows:
            blob(root,row['id']).unlink(missing_ok=True)
            db.execute('DELETE FROM files WHERE id=?',(row['id'],))
        db.execute('DELETE FROM limits WHERE expires<?',(now,));db.commit()
    return len(rows)
def verify(archive):
    with tarfile.open(archive,'r:gz') as tar:
        members=tar.getmembers();names=[m.name for m in members]
        if len(names)!=len(set(names)) or any(not m.isfile() for m in members): raise ValueError('Invalid archive entries')
        manifest=json.load(tar.extractfile('manifest.json'))
        expected={'manifest.json','metadata.sqlite'}|{'blobs/'+f['id'] for f in manifest['files']}
        if set(names)!=expected: raise ValueError('Archive inventory mismatch')
        checks={'metadata.sqlite':manifest['databaseSha256'],**{'blobs/'+f['id']:f['hash'] for f in manifest['files']}}
        for name,digest in checks.items():
            h=hashlib.sha256()
            with tar.extractfile(name) as f:
                for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
            if h.hexdigest()!=digest:raise ValueError('Archive checksum mismatch')
    # Reading every member and to end validates gzip CRC, including trailer.
    import gzip
    with gzip.open(archive,'rb') as f:
        while f.read(1024*1024):pass
    return manifest
def snapshot(root,destination):
    destination=Path(destination)
    if not destination.is_absolute() or destination.exists():raise ValueError('Use a new absolute archive path')
    destination.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='engraving-snapshot-',dir=root) as work:
        work=Path(work);copy=work/'metadata.sqlite'
        with connection(root) as source, sqlite3.connect(copy) as target:
            source.backup(target)
            target.execute("DELETE FROM files WHERE state NOT IN ('bound','archived')");target.execute('DELETE FROM limits');target.commit()
            rows=[dict(zip([x[0] for x in cursor.description],r)) for cursor in [target.execute("SELECT * FROM files WHERE state='bound' ORDER BY id")] for r in cursor]
            target.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        target.close()
        total=sum(row['size'] for row in rows)
        if shutil.disk_usage(destination.parent).free < total+5*1024**3:raise ValueError('Insufficient backup reserve')
        manifest={'version':1,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'databaseSha256':sha(copy),'files':rows}
        (work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8')
        temp=destination.with_suffix(destination.suffix+'.partial')
        try:
            with tarfile.open(temp,'w:gz',compresslevel=1) as tar:
                for name in ['metadata.sqlite','manifest.json']:tar.add(work/name,arcname=name,recursive=False)
                for row in rows:
                    p=blob(root,row['id'])
                    if p.stat().st_size!=row['size'] or sha(p)!=row['hash']:raise ValueError('Source checksum mismatch')
                    tar.add(p,arcname='blobs/'+row['id'],recursive=False)
            os.chmod(temp,0o600);verify(temp);os.replace(temp,destination)
            return {'path':str(destination),'sha256':sha(destination),'files':len(rows),'bytes':destination.stat().st_size}
        finally: temp.unlink(missing_ok=True)
def daily(root):
    copies=root/'backups';copies.mkdir(mode=0o700,exist_ok=True)
    current=sorted(p for p in copies.iterdir() if p.is_file() and not p.is_symlink() and re.fullmatch(r'\d{8}-\d{6}\.tar\.gz',p.name))
    if current and time.time()-current[-1].stat().st_mtime < 23*3600:return {'backup':'recent'}
    name=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')+'.tar.gz'
    result=snapshot(root,copies/name)
    # Keep two complete, verified daily copies. Originals are untouched.
    for p in current[:-1]:
        if p.resolve().parent!=copies.resolve():raise ValueError('Unexpected backup path')
        p.unlink()
    return result
def prune_completed(root,archive,expected_sha,ids):
    archive=Path(archive)
    if sha(archive)!=expected_sha:raise ValueError('Archive SHA mismatch')
    manifest=verify(archive);saved={r['id']:r for r in manifest['files']}
    if not ids or len(ids)!=len(set(ids)):raise ValueError('Supply exact unique file IDs')
    with connection(root) as db:
        db.execute('BEGIN IMMEDIATE')
        rows=[]
        for id in ids:
            row=db.execute('SELECT * FROM files WHERE id=?',(id,)).fetchone();entry=saved.get(id)
            if not row or row['state']!='bound' or not row['order_id'] or row['created']>time.time()*1000-90*86400000:raise ValueError('Only confirmed orders older than 90 days')
            if not entry or row['hash']!=entry['hash'] or row['order_id']!=entry['order_id'] or sha(blob(root,id))!=row['hash']:raise ValueError('Archive does not match current file')
            rows.append(row)
        for row in rows:
            db.execute("UPDATE files SET state='archived',archived=? WHERE id=?",(expected_sha,row['id']))
        db.commit()
        # Metadata commits first. A power failure can only leave an extra blob, never lose the archive reference.
        for row in rows:blob(root,row['id']).unlink()
    return len(rows)
def main():
    os.umask(0o077)
    p=argparse.ArgumentParser();p.add_argument('command',choices=['maintain','snapshot','verify','stats','prune-completed']);p.add_argument('--root');p.add_argument('--archive');p.add_argument('--sha256');p.add_argument('--id',action='append',default=[])
    a=p.parse_args()
    if a.command=='verify':
        m=verify(Path(a.archive));print(json.dumps({'verified':True,'files':len(m['files']),'sha256':sha(a.archive)}));return
    root=storage(a.root)
    with lock(root):
        if a.command=='maintain':result={'removedAbandoned':cleanup(root),'backup':daily(root)}
        elif a.command=='snapshot':result=snapshot(root,Path(a.archive))
        elif a.command=='prune-completed':result={'archived':prune_completed(root,a.archive,a.sha256,a.id)}
        else:
            with connection(root) as db:result=[dict(r) for r in db.execute('SELECT state,count(*) files,COALESCE(sum(size),0) bytes FROM files GROUP BY state')]
        print(json.dumps(result))
if __name__=='__main__':main()
