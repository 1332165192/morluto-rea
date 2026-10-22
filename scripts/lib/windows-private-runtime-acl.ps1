param($Acl, [string]$UserSid, [string]$Path, [Diagnostics.Stopwatch]$Clock)

# Keep this independent observer on .NET SID APIs. PowerShell convenience
# properties and utility cmdlets can introduce account lookup/module loading.
$PSModuleAutoLoadingPreference = 'None'
function Trace-AclPhase([string]$phase) {
    [Console]::Error.WriteLine('private-runtime-acl: ' + $phase + ' ' + $Clock.ElapsedMilliseconds + 'ms')
}
$owner = $Acl.GetOwner([Security.Principal.SecurityIdentifier])
Trace-AclPhase 'owner-sid-read'
$rules = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
Trace-AclPhase 'rule-sids-read'
$trusteesOnlyUserAndSystem = $true
foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if ($sid -ne $UserSid -and $sid -ne 'S-1-5-18') {
        $trusteesOnlyUserAndSystem = $false
    }
}
[IO.File]::SetAttributes($Path, [IO.FileAttributes]([int][IO.File]::GetAttributes($Path) -bor 1))
Trace-AclPhase 'readonly-set'

# The wire values are exclusively booleans and a collection count, so no
# arbitrary strings need JSON escaping or a general-purpose serializer.
$values = @(
    ([bool]$Acl.AreAccessRulesProtected).ToString().ToLowerInvariant(),
    ($owner.Value -eq $UserSid).ToString().ToLowerInvariant(),
    $trusteesOnlyUserAndSystem.ToString().ToLowerInvariant(),
    $rules.Count.ToString([Globalization.CultureInfo]::InvariantCulture),
    (([int][IO.File]::GetAttributes($Path) -band 1) -ne 0).ToString().ToLowerInvariant()
)
[Console]::WriteLine(('{{"protected":{0},"ownerMatchesUser":{1},"trusteesOnlyUserAndSystem":{2},"count":{3},"rootReadonly":{4}}}' -f $values))
Trace-AclPhase 'complete'
