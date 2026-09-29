from pathlib import Path
import re, subprocess, json, csv, sys
if len(sys.argv) != 3:
    raise SystemExit('usage: measure.py SOURCE_SNAPSHOT OUTPUT_DIRECTORY')
root=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
measurement=out/'measurement'
files=sorted(p for p in root.rglob('*') if p.is_file() and p.suffix in {'.rs','.ts','.tsx','.js','.mjs'})

def rust_mask(source):
    chars=list(source); i=0; n=len(source)
    def hide(a,b):
        for j in range(a,b):
            if chars[j]!='\n': chars[j]=' '
    while i<n:
        start=i
        if source.startswith('//',i):
            end=source.find('\n',i); i=n if end<0 else end
        elif source.startswith('/*',i):
            i+=2; depth=1
            while i<n and depth:
                if source.startswith('/*',i): depth+=1; i+=2
                elif source.startswith('*/',i): depth-=1; i+=2
                else: i+=1
        elif (m:=re.match(r'(?:br|cr|r)(#*)"',source[i:])):
            ending='"'+m.group(1); end=source.find(ending,i+len(m.group(0)))
            assert end>=0, 'unterminated raw string'
            i=end+len(ending)
        elif source[i]=='"':
            i+=1
            while i<n:
                if source[i]=='\\': i+=2
                elif source[i]=='"': i+=1; break
                else: i+=1
        elif source[i]=="'" and (m:=re.match(r"'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'",source[i:])):
            i+=len(m.group(0))
        else:
            i+=1; continue
        hide(start,min(i,n))
    return ''.join(chars)

manifest=[]; modules=[]
for path in files:
    rel=path.relative_to(root); name=rel.as_posix(); source=path.read_text()
    is_test=('/tests/' in '/'+name or '/test/' in '/'+name or '/e2e/' in '/'+name or '/e2e-native/' in '/'+name or re.search(r'\.(?:test|spec)\.',name) or re.search(r'(?:^|/)(?:tests|test_support|testSetup|setupTests)\.',name) or re.search(r'_(?:tests|fixtures|eval)\.rs$',name))
    if '/test-contracts/' in name or rel.name in {'approvalStatusFixture.ts','chatPaneTestHarness.tsx','graphTransform.fixture.ts','sourceEditorTableContractFixture.ts'}: is_test=True
    if '/lib/bindings/' in name: group='generated'
    elif is_test: group='dedicated-tests'
    elif name.startswith('app/desktop/src/') and path.suffix in {'.ts','.tsx'}: group='frontend-production'
    elif path.suffix=='.rs' and '/src/' in '/'+name: group='rust-production'
    else: group='tooling-other'
    if group=='rust-production':
        mask=rust_mask(source); ranges=[]
        for match in re.finditer(r'(?m)^\s*#\[cfg\(test\)\]\s*mod\s+\w+\s*\{',mask):
            start=match.start(); opening=mask.find('{',start); depth=1; end=opening+1
            while end<len(mask) and depth:
                if mask[end]=='{': depth+=1
                elif mask[end]=='}': depth-=1
                end+=1
            assert depth==0, name
            ranges.append((start,end))
            modules.append({'file':name,'start_line':source.count('\n',0,start)+1,'end_line':source.count('\n',0,end)+1})
        if ranges:
            inline='\n'.join(source[a:b] for a,b in ranges)
            target=measurement/'rust-inline-tests'/rel; target.parent.mkdir(parents=True,exist_ok=True); target.write_text(inline)
            manifest.append({'path':str(target),'source':name,'group':'rust-inline-tests'})
            for a,b in reversed(ranges): source=source[:a]+''.join('\n' if c=='\n' else ' ' for c in source[a:b])+source[b:]
    target=measurement/group/rel; target.parent.mkdir(parents=True,exist_ok=True); target.write_text(source)
    manifest.append({'path':str(target),'source':name,'group':group})
(out/'files.txt').write_text('\n'.join(x['path'] for x in manifest)+'\n')
(out/'manifest.json').write_text(json.dumps({'files':manifest,'removed_inline_test_modules':modules},indent=2)+'\n')
subprocess.run(['cloc','--skip-uniqueness','--by-file','--json','--quiet','--list-file='+str(out/'files.txt'),'--out='+str(out/'cloc.json')],check=True)
raw=json.loads((out/'cloc.json').read_text()); groups={}; rows=[]
for item in manifest:
    counts=raw.get(item['path'])
    if counts is None: continue
    g=groups.setdefault(item['group'],{'files':0,'code':0,'comment':0,'blank':0})
    g['files']+=1
    for key in ('code','comment','blank'): g[key]+=counts[key]
    rows.append({**item,**{k:counts[k] for k in ('code','comment','blank')},'comment_share':round(100*counts['comment']/max(1,counts['comment']+counts['code']),2)})
for g in groups.values(): g['comment_share']=round(100*g['comment']/max(1,g['comment']+g['code']),2)
summary={'cloc_version':'2.10','source_directory':str(root),'source_files':len(files),'inline_modules_removed':len(modules),'groups':groups}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
with (out/'per-file.csv').open('w') as f:
    writer=csv.DictWriter(f,fieldnames=list(rows[0]),lineterminator="\n");writer.writeheader();writer.writerows(rows)
print(json.dumps(summary,indent=2))
production=[r for r in rows if r['group'] in {'frontend-production','rust-production'}]
print('TOP COMMENT SHARE (at least 50 nonblank lines):')
for r in sorted((r for r in production if r['code']+r['comment']>=50),key=lambda r:r['comment_share'],reverse=True)[:16]: print(r['source'], 'comments',r['comment'],'code',r['code'],'share',r['comment_share'])
print('TOP COMMENT COUNTS:')
for r in sorted(production,key=lambda r:r['comment'],reverse=True)[:10]: print(r['source'],'comments',r['comment'],'code',r['code'],'share',r['comment_share'])
