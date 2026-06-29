# GitHub Repository

Requested private repository target:

```text
hengkp/sisp-mapdrive
```

Git and GitHub CLI are installed locally. `gh` is not authenticated yet.

Safe token workflow:

```powershell
Set-Content -Path C:\Users\user\.github-token-sisp-mapdrive.txt -Value '<TOKEN>'
gh auth login --with-token < C:\Users\user\.github-token-sisp-mapdrive.txt
Remove-Item C:\Users\user\.github-token-sisp-mapdrive.txt
```

Then create and push the private repository:

```powershell
cd C:\Users\user\sisp-mapdrive
gh repo create hengkp/sisp-mapdrive --private --source . --remote origin --push
```

Current local repository:

```text
C:\Users\user\sisp-mapdrive
```

A complete archive is also available at:

```text
C:\Users\user\sisp-mapdrive-project.zip
```
