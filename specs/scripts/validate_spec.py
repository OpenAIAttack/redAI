#!/usr/bin/env python3
"""Offline validation of a redAI specification bundle; never executes product/tools.

This is not a full OpenAPI meta-schema validator or a PostgreSQL parser. Results
explicitly distinguish static structure/fixtures from unperformed application tests.
"""
from __future__ import annotations
import argparse, base64, hashlib, importlib.metadata, json, re, sys
from collections import Counter
from pathlib import Path
from urllib.parse import urldefrag, unquote, urlparse
import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_BASE = 'https://schemas.redai.invalid/v1/'
HTTP_METHODS = {'get','put','post','delete','options','head','patch','trace'}
issues: list[str] = []
checks: Counter = Counter()

def require(condition: bool, label: str, category: str) -> None:
    checks[category] += 1
    if not condition: issues.append(label)

def load_json(path: Path):
    def pairs(items):
        result = {}
        for k,v in items:
            if k in result: raise ValueError(f'Duplicate JSON key: {k}')
            result[k] = v
        return result
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=pairs)

def walk(value):
    if isinstance(value, dict):
        yield value
        for v in value.values(): yield from walk(v)
    elif isinstance(value, list):
        for v in value: yield from walk(v)

def pointer(doc, fragment: str):
    if not fragment: return doc
    if not fragment.startswith('/'): raise ValueError('Only JSON Pointer fragments supported')
    for part in fragment[1:].split('/'):
        part = unquote(part).replace('~1','/').replace('~0','~')
        doc = doc[int(part)] if isinstance(doc,list) else doc[part]
    return doc

def ref_target(ref: str, source: Path, docs: dict[Path, object]):
    uri, fragment = urldefrag(ref)
    if uri.startswith(SCHEMA_BASE):
        path = ROOT/'contracts/schemas'/uri[len(SCHEMA_BASE):]
    elif urlparse(uri).scheme:
        raise ValueError(f'Unregistered external reference {ref}')
    else:
        path = source if not uri else source.parent/unquote(uri)
    path = path.resolve()
    if not path.is_relative_to(ROOT): raise ValueError('Reference escapes bundle')
    if path not in docs: raise ValueError(f'Reference file not loaded: {path.relative_to(ROOT)}')
    return pointer(docs[path], fragment)

# Split a small PostgreSQL DDL subset for table/column/FK lint. NOT a SQL parser.
def split_top(text: str):
    depth=0; quoted=False; parts=[]; start=0; i=0
    while i<len(text):
        ch=text[i]
        if ch=="'":
            if quoted and i+1<len(text) and text[i+1]=="'": i+=2; continue
            quoted=not quoted
        elif not quoted:
            if ch=='(': depth+=1
            elif ch==')': depth-=1
            elif ch==',' and depth==0: parts.append(text[start:i].strip());start=i+1
        i+=1
    parts.append(text[start:].strip());return parts

def table_blocks(sql: str):
    for m in re.finditer(r'CREATE TABLE\s+(\w+)\s*\(',sql,re.I):
        start=m.end();depth=1;quoted=False;i=start
        while i<len(sql) and depth:
            ch=sql[i]
            if ch=="'":
                if quoted and i+1<len(sql) and sql[i+1]=="'": i+=2;continue
                quoted=not quoted
            elif not quoted:
                if ch=='(':depth+=1
                elif ch==')':depth-=1
            i+=1
        if depth:raise ValueError(f'Unbalanced CREATE TABLE {m[1]}')
        yield m[1],sql[start:i-1]

def cols(raw): return tuple(x.strip() for x in raw.split(','))

def main() -> int:
    docs={}
    for p in sorted(ROOT.rglob('*.json')):
        if p.name in {'validation-results.json','MANIFEST.json'}: continue
        try: docs[p.resolve()]=load_json(p);require(True,str(p),'json_documents')
        except Exception as exc: require(False,f'{p.relative_to(ROOT)}: {exc}','json_documents')
    for p in sorted((ROOT/'contracts').glob('*.yaml')):
        try: docs[p.resolve()]=yaml.safe_load(p.read_text());require(True,str(p),'yaml_documents')
        except Exception as exc:require(False,f'{p.relative_to(ROOT)}: {exc}','yaml_documents')
    schema_docs={p:d for p,d in docs.items() if p.parent.name=='schemas'}
    registry=Registry()
    ids=set()
    for p,s in schema_docs.items():
        try:
            Draft202012Validator.check_schema(s)
            require(s['$id'] not in ids,f'Duplicate schema id: {p}','schema_metaschema')
            ids.add(s['$id']);registry=registry.with_resource(s['$id'],Resource.from_contents(s))
        except Exception as exc:require(False,f'Schema {p.name}: {exc}','schema_metaschema')
    for p,d in docs.items():
        for node in walk(d):
            if '$ref' not in node:continue
            try:ref_target(node['$ref'],p,docs);require(True,'ref','references')
            except Exception as exc:require(False,f'{p.relative_to(ROOT)} {node["$ref"]}: {exc}','references')
    operations={}
    for p in (ROOT/'contracts').glob('*.openapi.yaml'):
        d=docs[p.resolve()];ids_op=[]
        require(d.get('openapi')=='3.1.0',f'{p.name}: OpenAPI version','openapi_structure')
        require(bool(d.get('info',{}).get('version')),f'{p.name}: info.version','openapi_structure')
        for path,item in d['paths'].items():
            require(path.startswith('/'),f'{p.name}: invalid path {path}','openapi_structure')
            for method,op in item.items():
                if method not in HTTP_METHODS:continue
                oid=op.get('operationId');ids_op.append(oid)
                require(bool(oid),f'{method} {path}: missing operationId','openapi_structure')
                params=item.get('parameters',[])+op.get('parameters',[])
                resolved=[ref_target(x['$ref'],p.resolve(),docs) if '$ref' in x else x for x in params]
                names=[(x.get('in'),x.get('name')) for x in resolved]
                require(len(names)==len(set(names)),f'{oid}: duplicate parameter','openapi_structure')
                actual={x['name'] for x in resolved if x.get('in')=='path'}
                require(actual==set(re.findall(r'{([^}]+)}',path)),f'{oid}: path parameters mismatch','openapi_structure')
                require(all(x.get('required') is True for x in resolved if x.get('in')=='path'),f'{oid}: optional path parameter','openapi_structure')
                require(bool(op.get('responses')),f'{oid}: missing responses','openapi_structure')
                for code,resp in op.get('responses',{}).items():
                    require(bool(re.fullmatch(r'[1-5][0-9X]{2}|default',str(code))),f'{oid}: invalid response {code}','openapi_structure')
                    require('description' in resp or '$ref' in resp,f'{oid}: response description','openapi_structure')
                if p.name=='public.openapi.yaml' and method in {'post','put','patch','delete'} and path!='/auth/login':
                    require(('header','X-CSRF-Token') in names,f'{oid}: missing CSRF header','openapi_structure')
                # Validate embedded schema syntax, not the complete OpenAPI dialect.
                for node in walk(op):
                    if 'schema' in node and isinstance(node['schema'],(dict,bool)):
                        try:Draft202012Validator.check_schema(node['schema']);require(True,'embedded','openapi_embedded_schema')
                        except Exception as exc:require(False,f'{oid}: {exc}','openapi_embedded_schema')
        require(len(ids_op)==len(set(ids_op)),f'{p.name}: duplicate operationId','openapi_structure')
        operations[p.name]=len(ids_op)
    outcomes=[]
    manifest=load_json(ROOT/'tests/contract-cases.json')
    for case in manifest['cases']:
        ref=SCHEMA_BASE+case['schema']
        try:
            schema={'$schema':'https://json-schema.org/draft/2020-12/schema','$ref':ref}
            validator=Draft202012Validator(schema,registry=registry,format_checker=FormatChecker())
            errors=list(validator.iter_errors(load_json(ROOT/case['fixture'])))
            actual=not errors
            require(actual==case['expected_valid'],f'Fixture {case["id"]}: expected {case["expected_valid"]}, actual {actual}; '+str([e.message for e in errors])[:500],'fixture_expectations')
            outcomes.append({'id':case['id'],'expected_valid':case['expected_valid'],'actual_valid':actual,'matched':actual==case['expected_valid']})
        except Exception as exc:require(False,f'Fixture {case["id"]}: {exc}','fixture_expectations')
    # Restricted deterministic signature fixture: not a general JCS implementation.
    vector=load_json(ROOT/'tests/signature-vector.json');envelope=load_json(ROOT/vector['envelope_fixture'])
    def dec(s):return base64.urlsafe_b64decode(s+'='*((-len(s))%4))
    try:
        h,p,s=envelope['lease_jws'].split('.')
        pub=Ed25519PublicKey.from_public_bytes(dec(vector['public_key_base64url']))
        pub.verify(dec(s),(h+'.'+p).encode());require(True,'signature','signature_vector')
        require(json.loads(dec(p))==envelope['claims'],'Signed and outer claims differ','signature_vector')
        require(dec(p).decode()==vector['claims_canonical_utf8'],'Canonical claims mismatch','signature_vector')
        require(hashlib.sha256(vector['input_canonical_utf8'].encode()).hexdigest()==envelope['claims']['input_sha256'],'Input digest mismatch','signature_vector')
        require(json.loads(vector['input_canonical_utf8'])==envelope['input'],'Input not bound','signature_vector')
        try:pub.verify(dec(s),(h+'.'+p+'x').encode());tamper_blocked=False
        except InvalidSignature:tamper_blocked=True
        require(tamper_blocked,'Tampered signature not rejected','signature_vector')
        result=load_json(ROOT/'contracts/examples/worker-result-valid.json');digest=result.pop('result_sha256')
        encoded=json.dumps(result,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
        require(hashlib.sha256(encoded).hexdigest()==digest,'Result digest must omit result_sha256 field','signature_vector')
    except Exception as exc:require(False,f'Signature fixture: {exc}','signature_vector')
    lock=load_json(ROOT/'SPEC_LOCK.json')
    common=load_json(ROOT/'contracts/schemas/common.schema.json')['$defs']
    for key,defn in [('approval_modes','ApprovalMode'),('run_states','RunState'),('attempt_states','AttemptState'),('effect_classes','EffectClass')]:
        require(lock[key]==common[defn]['enum'],f'SPEC_LOCK.{key} mismatch','cross_contract')
    catalog=load_json(ROOT/'catalogs/tools.json')['tools']
    require(len({x['name'] for x in catalog})==len(catalog),'Duplicate tool name','cross_contract')
    for tool in catalog:
        require(tool['effect_class'] in lock['effect_classes'],f'{tool["name"]}: effect class','cross_contract')
        require(tool['timeout_seconds']<=lock['defaults']['tool_timeout_max_seconds'],f'{tool["name"]}: timeout','cross_contract')
        require(tool['max_artifact_bytes']==lock['defaults']['upload_max_bytes'],f'{tool["name"]}: artifact limit','cross_contract')
        require(tool['secrets_in_prompt'] is False,f'{tool["name"]}: secrets in prompt','cross_contract')
        try:ref_target(tool['input_schema'],(ROOT/'catalogs/tools.json').resolve(),docs);require(True,'tool ref','cross_contract')
        except Exception as exc:require(False,f'Tool input ref: {exc}','cross_contract')
    tasks=load_json(ROOT/'implementation/tasks.json')['tasks'];taskids={t['id'] for t in tasks}
    require(len(taskids)==len(tasks),'Duplicate task ID','backlog')
    for task in tasks:
        require(set(task['depends_on'])<=taskids,task['id']+': missing dependency','backlog')
        require(task['id'] not in task['depends_on'],task['id']+': self dependency','backlog')
        require(bool(task.get('tests')) and bool(task.get('acceptance_criteria')),task['id']+': missing tests/acceptance','backlog')
        for ref in task['spec_refs']:require((ROOT/ref).exists(),task['id']+': missing '+ref,'backlog')
    remaining={x['id']:set(x['depends_on']) for x in tasks};order=[]
    while remaining:
        ready=sorted(k for k,v in remaining.items() if not v)
        if not ready:break
        for k in ready:order.append(k);remaining.pop(k)
        for v in remaining.values():v.difference_update(ready)
    require(not remaining,'Dependency cycle: '+str(remaining),'backlog')
    reqs=load_json(ROOT/'implementation/requirements.json')['requirements']
    require(len({x['id'] for x in reqs})==len(reqs),'Duplicate requirement ID','backlog')
    for req in reqs:
        require(set(req['tasks'])<=taskids,req['id']+': missing task','backlog')
        require((req['gate'] in {f'G{x}' for x in range(8)} or (req['gate']=='OPTIONAL' and req.get('priority')=='OPTIONAL')),req['id']+': invalid gate','backlog')
        require(bool(req['acceptance_test']),req['id']+': missing acceptance test','backlog')
    vector_counts={}
    for filename in ['policy-cases.json','recovery-cases.json']:
        data=load_json(ROOT/'tests'/filename);items=data['cases'];vector_counts[filename]=len(items)
        require(len({x['id'] for x in items})==len(items),filename+': duplicate IDs','behavior_vector_structure')
        require('status' in data and 'not_' in data['status'],filename+': must declare not executed','behavior_vector_structure')
    # Relative file links only; source URLs/anchor rendering are outside this check.
    for p in ROOT.rglob('*.md'):
        text=p.read_text()
        for target in re.findall(r'(?<!!)\[[^\]\n]+\]\(([^)]+)\)',text):
            if urlparse(target).scheme or target.startswith('#'):continue
            target=unquote(target.split('#',1)[0])
            require((p.parent/target).exists(),f'{p.relative_to(ROOT)}: missing link {target}','markdown_links')
    # Conservative DDL lint; do not report SQL syntax or DB migration as validated.
    sql=(ROOT/'db/001_reference_schema.sql').read_text();tables={};fks=[]
    try:
        for name,body in table_blocks(sql):
            require(name not in tables,'Duplicate SQL table '+name,'ddl_structure')
            columns=set();unique=set()
            for part in split_top(body):
                m=re.match(r'(\w+)\s+(.+)',part,re.S)
                if m and m[1].upper() not in {'UNIQUE','PRIMARY','FOREIGN','CHECK','CONSTRAINT'}:
                    column=m[1];columns.add(column)
                    if re.search(r'\bPRIMARY KEY\b|\bUNIQUE\b',m[2],re.I):unique.add((column,))
                    rf=re.search(r'REFERENCES\s+(\w+)\s*\(([^)]+)\)',m[2],re.I)
                    if rf:fks.append((name,(column,),rf[1],cols(rf[2])))
                for u in re.finditer(r'(?:PRIMARY KEY|UNIQUE)\s*\(([^)]+)\)',part,re.I):unique.add(cols(u[1]))
                for f in re.finditer(r'FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\w+)\s*\(([^)]+)\)',part,re.I):fks.append((name,cols(f[1]),f[2],cols(f[3])))
            tables[name]={'columns':columns,'unique':unique}
        for m in re.finditer(r'ALTER TABLE\s+(\w+)\s+ADD CONSTRAINT\s+\w+\s+FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\w+)\s*\(([^)]+)\)',sql,re.I):
            fks.append((m[1],cols(m[2]),m[3],cols(m[4])))
        for src,sc,dst,dc in fks:
            require(src in tables and dst in tables,f'FK table missing {src}->{dst}','ddl_structure')
            if src not in tables or dst not in tables:continue
            require(set(sc)<=tables[src]['columns'],f'FK source column missing {src}{sc}','ddl_structure')
            require(set(dc)<=tables[dst]['columns'],f'FK target column missing {dst}{dc}','ddl_structure')
            require(len(sc)==len(dc),f'FK arity mismatch {src}->{dst}','ddl_structure')
            require(dc in tables[dst]['unique'],f'FK target not declared PK/UNIQUE {dst}{dc}','ddl_structure')
        require('COMMIT;' in sql and 'BEGIN;' in sql,'DDL transaction wrapper missing','ddl_structure')
    except Exception as exc:require(False,f'DDL static lint: {exc}','ddl_structure')
    counts={'narrative_documents':len(list((ROOT/'docs').glob('*.md'))),'adrs':len(list((ROOT/'adr').glob('[0-9]*.md'))),'json_schemas':len(schema_docs),'api_operations':operations,'tables':len(tables),'foreign_keys_linted':len(fks),'tools':len(catalog),'tasks':len(tasks),'requirements':len(reqs),'fixture_cases':len(outcomes),'fixture_expectations_matched':sum(x['matched'] for x in outcomes),'behavior_vectors':vector_counts}
    not_performed=[
        'Full OpenAPI meta-schema validation/code generation with production client generators.',
        'PostgreSQL grammar parsing, applying migrations, constraints/transactions on a live database.',
        'Application implementation, unit/integration/E2E tests, browser UI verification.',
        'Worker/lease/policy engine execution, live network requests, gVisor/proxy isolation tests.',
        'Production model calls, real cost measurements, live pentesting, performance benchmarks.',
        'Backup/restore drills, deployment, security audit, release gates G0-G7.'
    ]
    report={'status':'PASS_STATIC_BUNDLE_CHECKS' if not issues else 'FAIL','check_groups':dict(checks),'counts':counts,'fixture_results':outcomes,'task_topological_order':order,'issues':issues,'not_performed':not_performed,'dependencies':{n:importlib.metadata.version(n) for n in ['PyYAML','jsonschema','cryptography']}}
    (ROOT/'tests/validation-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    text=['# Báo cáo kiểm tra bộ đặc tả redAI','',f'**Kết quả: {report["status"]}.** Kiểm tra offline trên tài liệu/hợp đồng; không phải nghiệm thu sản phẩm.','', '## Đã chạy thực tế','', '| Nhóm kiểm tra | Số phép kiểm tra |','|---|---:|']
    text += [f'| {k} | {v} |' for k,v in sorted(checks.items())]
    text += ['',f'Fixtures: **{counts["fixture_expectations_matched"]}/{len(outcomes)}** khớp kết quả mong đợi; có cả mẫu hợp lệ và mẫu cố ý không hợp lệ. Chữ ký fixture và digest đã được kiểm tra, bao gồm dữ liệu bị sửa.','',f'Backlog: **{len(tasks)} task**, DAG không chu kỳ nếu PASS; **{len(reqs)} yêu cầu** có mapping task/gate/test.','',f'Hợp đồng: **{len(schema_docs)} JSON Schema**, **{sum(operations.values())} API operations**, **{len(tables)} bảng** và **{len(fks)} foreign key** được lint cấu trúc.','', '**Giới hạn quan trọng:** OpenAPI chỉ được parse YAML, kiểm tra references, operation IDs, path parameters, responses và embedded schema; không phải validator OpenAPI đầy đủ. SQL chỉ được lint tên bảng/cột/FK/PK/UNIQUE trong subset đã dùng; không được diễn giải là SQL đã biên dịch hoặc migration thành công.','', '**32 policy vectors và 18 recovery scenarios** là đặc tả test hành vi, chưa chạy với application.','', '## Chưa thực hiện','']
    text += [f'- {x}' for x in not_performed]
    if issues:text+=['','## Lỗi']+[f'- {x}' for x in issues]
    text += ['','## Tái lập','', '```bash','python -m pip install -r scripts/requirements-validation.txt','python scripts/validate_spec.py','```','', 'Chi tiết máy đọc được: `tests/validation-results.json`. Mọi task triển khai trong `implementation/STATUS.md` vẫn NOT_STARTED.']
    (ROOT/'VALIDATION_REPORT.md').write_text('\n'.join(text)+'\n')
    print(json.dumps({'status':report['status'],'counts':counts,'issues':issues},ensure_ascii=False,indent=2))
    return 0 if not issues else 1

if __name__=='__main__':
    try:sys.exit(main())
    except Exception as exc:
        print(f'Validator failed without claiming success: {exc}',file=sys.stderr);sys.exit(2)
