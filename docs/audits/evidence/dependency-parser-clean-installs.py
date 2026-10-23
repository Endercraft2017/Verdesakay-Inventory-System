import json, pathlib, shutil, subprocess, tempfile

root=pathlib.Path.cwd()
work=root/'work'
report=[]
for mode in ['before','after']:
    directory=pathlib.Path(tempfile.mkdtemp(prefix=f'otom-parser-{mode}-'))
    for name in ['package.json','package-lock.json']:
        if mode=='before':
            data=subprocess.check_output(['git','show',f'212ff016a87849541b1a05b317b7e431a89eef10:{name}'])
            (directory/name).write_bytes(data)
        else:
            shutil.copyfile(root/name,directory/name)
    with (work/f'dependency-followup-ci-{mode}.txt').open('w') as log:
        install=subprocess.run(['npm','ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=directory,stdout=log,stderr=subprocess.STDOUT)
    assert install.returncode==0, (mode,'install failed')
    with (work/f'dependency-followup-probe-{mode}.json').open('w') as log:
        probe=subprocess.run(['node',str(work/'dependency-followup-install-probe.mjs'),str(directory),str(work/'dependency-followup-clean.docx'),mode],stdout=log,check=True)
    with (work/f'dependency-followup-tree-clean-{mode}.json').open('w') as log:
        subprocess.run(['npm','ls','mammoth','argparse','sprintf-js','node-forge','--omit=dev','--json'],cwd=directory,stdout=log,check=True)
    with (work/f'dependency-followup-audit-full-{mode}.json').open('w') as log:
        audit=subprocess.run(['npm','audit','--json'],cwd=directory,stdout=log)
    assert audit.returncode==1, (mode,'unexpected audit result')
    audit_json=json.loads((work/f'dependency-followup-audit-full-{mode}.json').read_text())
    assert audit_json.get('metadata'), (mode,'audit endpoint failed')
    report.append({'mode':mode,'install_exit':install.returncode,'probe_exit':probe.returncode,'full_audit_exit':audit.returncode,'full_audit':audit_json['metadata']['vulnerabilities']})
    shutil.rmtree(directory)
(work/'dependency-followup-clean-results.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
