import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const shellError =
  process.platform === "win32"
    ? undefined
    : spawnSync(
        shell,
        ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        {
          timeout: 15_000,
        },
      ).error;
const missingShell =
  shellError !== undefined &&
  "code" in shellError &&
  shellError.code === "ENOENT";

it.skipIf(missingShell)(
  "observes ACL facts without account lookup or PowerShell utility cmdlets",
  async () => {
    const observer = await readFile(
      new URL(
        "../../../scripts/lib/windows-private-runtime-acl.ps1",
        import.meta.url,
      ),
      "utf8",
    );
    const user = "S-1-5-21-123";
    const system = "S-1-5-18";
    const cases = [
      { owner: user, protected: true, trustees: [user, system] },
      { owner: system, protected: true, trustees: [user, system] },
      { owner: user, protected: false, trustees: [user, system] },
      {
        owner: user,
        protected: true,
        trustees: [user, system, "S-1-5-32-544"],
      },
      { owner: user, protected: true, trustees: [user] },
      { owner: user, protected: true, trustees: [] },
    ];
    const path = await mkdtemp(join(tmpdir(), "rea acl 観測-"));
    try {
      const output = execFileSync(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          String.raw`
            $ErrorActionPreference = 'Stop'
            $cases = $env:REA_ACL_CASES | ConvertFrom-Json
            $acls = @(foreach ($case in $cases) {
              $acl = [PSCustomObject]@{
                OwnerSid = $case.owner
                AreAccessRulesProtected = $case.protected
                Rules = @(foreach ($sid in $case.trustees) {
                  [PSCustomObject]@{ IdentityReference = [PSCustomObject]@{ Value = $sid } }
                })
              }
              $acl | Add-Member ScriptProperty Access { $script:accountLookups++; throw 'Account-name lookup is forbidden' }
              $acl | Add-Member ScriptMethod GetOwner {
                param($type)
                if ($type -ne [Security.Principal.SecurityIdentifier]) { throw 'Owner must request SID form' }
                [PSCustomObject]@{ Value = $this.OwnerSid }
              }
              $acl | Add-Member ScriptMethod GetAccessRules {
                param($explicit, $inherited, $type)
                if (!$explicit -or !$inherited -or $type -ne [Security.Principal.SecurityIdentifier]) {
                  throw 'Inspect all rules in SID form'
                }
                $this.Rules
              }
              $acl
            })
            Remove-Module Microsoft.PowerShell.Utility
            $PSModuleAutoLoadingPreference = 'None'
            $script:accountLookups = 0
            foreach ($acl in $acls) {
              [IO.File]::SetAttributes($env:REA_ACL_PATH, [IO.FileAttributes]::Directory)
              & { ${observer} } -Acl $acl -UserSid 'S-1-5-21-123' -Path $env:REA_ACL_PATH -Clock ([Diagnostics.Stopwatch]::StartNew())
              if ($script:accountLookups -ne 0) { throw 'Observer accessed account names' }
              if (Get-Module Microsoft.PowerShell.Utility) { throw 'Observer loaded utility cmdlets' }
              if (([int][IO.File]::GetAttributes($env:REA_ACL_PATH) -band 1) -eq 0) { throw 'Observer did not set readonly' }
            }
          `,
        ],
        {
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) => name.toLowerCase() !== "psmodulepath",
              ),
            ),
            REA_ACL_CASES: JSON.stringify(cases),
            REA_ACL_PATH: path,
          },
        },
      );
      expect(
        output
          .trim()
          .split(/\r?\n/u)
          .map((line) => JSON.parse(line)),
      ).toEqual([
        {
          protected: true,
          ownerMatchesUser: true,
          trusteesOnlyUserAndSystem: true,
          count: 2,
          rootReadonly: true,
        },
        {
          protected: true,
          ownerMatchesUser: false,
          trusteesOnlyUserAndSystem: true,
          count: 2,
          rootReadonly: true,
        },
        {
          protected: false,
          ownerMatchesUser: true,
          trusteesOnlyUserAndSystem: true,
          count: 2,
          rootReadonly: true,
        },
        {
          protected: true,
          ownerMatchesUser: true,
          trusteesOnlyUserAndSystem: false,
          count: 3,
          rootReadonly: true,
        },
        {
          protected: true,
          ownerMatchesUser: true,
          trusteesOnlyUserAndSystem: true,
          count: 1,
          rootReadonly: true,
        },
        {
          protected: true,
          ownerMatchesUser: true,
          trusteesOnlyUserAndSystem: true,
          count: 0,
          rootReadonly: true,
        },
      ]);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  },
  25_000,
);
