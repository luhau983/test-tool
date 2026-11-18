param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$report = [ordered]@{ schema = 1; collectedAt = (Get-Date).ToUniversalTime().ToString('o'); sections = [ordered]@{} }
function Section($Name, [scriptblock]$Action) {
    Write-Output $Name
    try {
        $data = @(& $Action)
        $report.sections[$Name] = @{ status = 'ok'; data = $data; error = $null }
    } catch {
        $report.sections[$Name] = @{ status = 'unknown'; data = @(); error = $_.Exception.Message }
    }
}
function Cim($Class, $Namespace = 'root/cimv2') {
    Get-CimInstance -ClassName $Class -Namespace $Namespace -OperationTimeoutSec 6 -ErrorAction Stop
}
$script:pnp = $null
function PnP { if ($null -eq $script:pnp) { $script:pnp = @(Cim 'Win32_PnPEntity') }; $script:pnp }
# Machine / BIOS / board / CPU / RAM identity comes only from the raw SMBIOS table (decoded in smbios.cjs).
Section 'firmwareRaw' {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FirmwareReader {
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern uint GetSystemFirmwareTable(uint provider, uint id, byte[] buffer, uint size);
    public static byte[] Read() {
        uint size = GetSystemFirmwareTable(0x52534D42, 0, null, 0);
        if(size < 8 || size > 8388608) throw new Exception("SMBIOS size invalid / unavailable");
        byte[] bytes = new byte[size];
        uint read = GetSystemFirmwareTable(0x52534D42, 0, bytes, size);
        if(read != size) throw new Exception("SMBIOS read incomplete");
        return bytes;
    }
}
'@
    [pscustomobject]@{Provider='GetSystemFirmwareTable(RSMB)'; Base64=[Convert]::ToBase64String([FirmwareReader]::Read())}
}
# Values Windows shows from the registry (CPU name, edition, build) are one regedit away from lying. Read them from the
# kernel / firmware instead: CPUID brand string cached by the kernel at boot, RtlGetVersion + GetProductInfo (licensing
# SKU), the ACPI MSDM table (OEM key burned into the BIOS) and PCI ids of display adapters. The registry copies are
# kept only to compare and flag edits. The full OEM key is never exported, only its last 5 characters.
Section 'hardwareTruth' {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TruthReader {
    [DllImport("ntdll.dll")] private static extern int NtQuerySystemInformation(int cls, byte[] buffer, int length, out int returned);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct OSVERSIONINFOW { public uint Size, Major, Minor, Build, Platform; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string CSD; }
    [DllImport("ntdll.dll")] private static extern int RtlGetVersion(ref OSVERSIONINFOW info);
    [DllImport("kernel32.dll")] private static extern bool GetProductInfo(uint major, uint minor, uint spMajor, uint spMinor, out uint type);
    [DllImport("kernel32.dll")] private static extern uint GetSystemFirmwareTable(uint provider, uint id, byte[] buffer, uint size);
    [StructLayout(LayoutKind.Sequential)]
    private class MEMORYSTATUSEX { public uint Length = 64, Load; public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual; }
    [DllImport("kernel32.dll")] private static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX m);
    public static ulong[] Memory() { MEMORYSTATUSEX m = new MEMORYSTATUSEX(); if (!GlobalMemoryStatusEx(m)) return null; return new ulong[] { m.TotalPhys, m.AvailPhys, m.Load }; }
    public static string CpuBrand() {
        byte[] b = new byte[64]; int got;
        if (NtQuerySystemInformation(105, b, b.Length, out got) != 0) return null; // SystemProcessorBrandString
        return Encoding.ASCII.GetString(b).TrimEnd('\0').Trim();
    }
    public static uint[] Version() {
        OSVERSIONINFOW v = new OSVERSIONINFOW(); v.Size = (uint)Marshal.SizeOf(typeof(OSVERSIONINFOW));
        if (RtlGetVersion(ref v) != 0) return null;
        uint sku; GetProductInfo(v.Major, v.Minor, 0, 0, out sku);
        return new uint[] { v.Major, v.Minor, v.Build, sku };
    }
    public static string OemKeyTail() {
        uint acpi = 0x41435049, msdm = BitConverter.ToUInt32(Encoding.ASCII.GetBytes("MSDM"), 0);
        uint size = GetSystemFirmwareTable(acpi, msdm, null, 0);
        if (size < 61) return null;
        byte[] t = new byte[size]; GetSystemFirmwareTable(acpi, msdm, t, size);
        int len = (int)Math.Min(BitConverter.ToUInt32(t, 52), size - 56);
        string key = Encoding.ASCII.GetString(t, 56, len).TrimEnd('\0').Trim();
        return key.Length >= 5 ? key.Substring(key.Length - 5) : null;
    }
}
'@
    $v = [TruthReader]::Version()
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
    # GPU model: the name the vendor's driver INF gives this exact PCI id. The INF is catalog-signed (WHQL), so an edited
    # one fails Get-AuthenticodeSignature; the registry name (what Windows shows) is a copy anyone can rename.
    $gpus = @(PnP | Where-Object { $_.PNPClass -eq 'Display' -and $_.PNPDeviceID -match 'VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})' } | ForEach-Object {
        $null = $_.PNPDeviceID -match 'VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})(?:&SUBSYS_([0-9A-F]{8}))?'
        $ven = $Matches[1]; $dev = $Matches[2]; $sub = $Matches[3]; $infFile = $null; $infName = $null; $signed = $null
        try {
            $infFile = (Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction Stop).Data
            $path = Join-Path $env:windir "INF\$infFile"
            if ($infFile -and (Test-Path -LiteralPath $path)) {
                $signed = ((Get-AuthenticodeSignature -LiteralPath $path).Status -eq 'Valid')
                $lines = Get-Content -LiteralPath $path
                $hits = @($lines | Where-Object { $_ -like "*PCI\VEN_$ven&DEV_$dev*" -and $_ -match '^\s*%[^%]+%\s*=' })
                $best = $hits | Where-Object { $sub -and $_ -like "*SUBSYS_$sub*" } | Select-Object -First 1
                if (-not $best) { $best = $hits | Where-Object { $_ -notlike '*SUBSYS_*' } | Select-Object -First 1 }
                if (-not $best) { $best = $hits | Select-Object -First 1 }
                if ($best -match '^\s*%([^%]+)%') { $token = [regex]::Escape($Matches[1])
                    $line = $lines | Where-Object { $_ -match "^\s*$token\s*=" } | Select-Object -First 1
                    if ($line -match '=\s*"?([^"]+?)"?\s*$') { $infName = $Matches[1].Trim() } }
            }
        } catch {}
        [pscustomobject]@{ VendorId = $ven; DeviceId = $dev; Subsys = $sub; WindowsName = $_.Name; InfFile = $infFile; InfName = $infName; InfSigned = $signed } })
    [pscustomobject]@{
        VisibleBytes = ([TruthReader]::Memory())[0]; AvailableBytes = ([TruthReader]::Memory())[1]; MemoryLoad = ([TruthReader]::Memory())[2]
        CpuBrand = [TruthReader]::CpuBrand(); Major = $v[0]; Minor = $v[1]; Build = $v[2]; ProductType = $v[3]; OemKeyTail = [TruthReader]::OemKeyTail()
        Gpus = $gpus
        RegCpuName = (Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -ErrorAction SilentlyContinue).ProcessorNameString
        RegEditionID = $cv.EditionID; RegProductName = $cv.ProductName; RegBuild = $cv.CurrentBuild; RegUBR = $cv.UBR
    }
}
Section 'keyboards' { . (Join-Path $PSScriptRoot 'keyboards.ps1'); Get-Keyboards }
Section 'displays' {
    # Physical panel size from EDID (cm) and how it is connected; VideoOutputTechnology 0x80000000 = built-in panel.
    $conn = @{}; Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorConnectionParams -ErrorAction SilentlyContinue | ForEach-Object { $conn[$_.InstanceName] = [int64]$_.VideoOutputTechnology }
    Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction Stop | Where-Object { $_.Active } | ForEach-Object {
        $tech = $conn[$_.InstanceName]
        [pscustomobject]@{ Instance = $_.InstanceName; WidthCm = [int]$_.MaxHorizontalImageSize; HeightCm = [int]$_.MaxVerticalImageSize; Internal = ($tech -eq 2147483648 -or $tech -eq -2147483648); Output = $tech }
    }
}
Section 'usb' { PnP | Where-Object {$_.PNPDeviceID -like 'USB*'} | Select-Object Name,PNPClass,Status,ConfigManagerErrorCode,PNPDeviceID }
Section 'security' {
    $secure = 'Chưa xác định'
    try {$secure = [string](Confirm-SecureBootUEFI -ErrorAction Stop)} catch {$secure = 'Chưa xác định: ' + $_.Exception.Message}
    $tpm = $null; $tpmError = $null
    try {$tpm = Get-Tpm -ErrorAction Stop} catch {$tpmError=$_.Exception.Message}
    [pscustomobject]@{SecureBoot=$secure;TpmPresent=$tpm.TpmPresent;TpmReady=$tpm.TpmReady;TpmVersion=$tpm.ManufacturerVersion;TpmError=$tpmError}
}
Section 'os' { Cim 'Win32_OperatingSystem' | Select-Object Caption,Version,BuildNumber,OSArchitecture,@{n='InstallDate';e={if ($_.InstallDate) {$_.InstallDate.ToString('yyyy-MM-dd')}}},@{n='LastBootUpTime';e={if ($_.LastBootUpTime) {$_.LastBootUpTime.ToString('yyyy-MM-dd HH:mm')}}},FreePhysicalMemory }
Section 'license' {
    # Windows product only (fixed ApplicationID); the full OEM key is never exported, only whether firmware carries one.
    $q = "SELECT Name,Description,LicenseStatus,PartialProductKey,ProductKeyChannel,GracePeriodRemaining,EvaluationEndDate,KeyManagementServiceMachine,DiscoveredKeyManagementServiceMachineName FROM SoftwareLicensingProduct WHERE ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL"
    $oemKey = $null
    try { $oemKey = [bool](Get-CimInstance -ClassName SoftwareLicensingService -OperationTimeoutSec 20 -ErrorAction Stop).OA3xOriginalProductKey } catch {}
    Get-CimInstance -Query $q -OperationTimeoutSec 30 -ErrorAction Stop | ForEach-Object {
        [pscustomobject]@{ Name=$_.Name; Channel=$(if ($_.ProductKeyChannel) {$_.ProductKeyChannel} else {$_.Description}); LicenseStatus=[int]$_.LicenseStatus; PartialProductKey=$_.PartialProductKey; GraceMinutes=$_.GracePeriodRemaining; OemKeyInFirmware=$oemKey; Description=$_.Description; EvaluationEndDate=$(if ($_.EvaluationEndDate -and $_.EvaluationEndDate.Year -gt 1601) { $_.EvaluationEndDate.ToUniversalTime().ToString('o') } else { $null }); KmsMachine=$_.KeyManagementServiceMachine; KmsDiscovered=$_.DiscoveredKeyManagementServiceMachineName }
    }
}
Section 'activation' {
    # Read-only look for leftovers of well-known Windows activation cracks (KMSpico, KMSAuto, AAct, KMS_VL_ALL, MAS online KMS).
    $found = @()
    $paths = @("$env:ProgramFiles\KMSpico", "${env:ProgramFiles(x86)}\KMSpico", "$env:ProgramData\KMSAutoS", "$env:SystemRoot\KMSAutoS", "$env:SystemRoot\AAct_Tools",
        "$env:ProgramData\Online_KMS_Activation", "$env:ProgramData\Activation-Renewal", "$env:SystemRoot\System32\SppExtComObjHook.dll",
        "$env:SystemRoot\System32\SECOH-QAD.exe", "$env:SystemRoot\System32\SECOH-QAD.dll")
    foreach ($p in $paths) { if ($p -and (Test-Path -LiteralPath $p)) { $found += "Tệp / thư mục: $p" } }
    Get-Service -ErrorAction SilentlyContinue | Where-Object { ($_.Name + ' ' + $_.DisplayName) -match 'KMSELDI|KMSpico|AutoKMS|KMSAuto|KMS Emulator' } | ForEach-Object { $found += "Dịch vụ: $($_.DisplayName)" }
    try { Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -match 'AutoPico|AutoKMS|KMSAuto|KMS_VL_ALL|Activation-Renewal|Activation-Run_Once|Online_KMS|AAct' } | ForEach-Object { $found += "Tác vụ hẹn giờ: $($_.TaskPath)$($_.TaskName)" } } catch {}
    $ifeo = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\SppExtComObj.exe' -ErrorAction SilentlyContinue
    if ($ifeo.Debugger -or $ifeo.VerifierDlls) { $found += 'Registry: hook SppExtComObj.exe (giả lập máy chủ KMS)' }
    $spp = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SoftwareProtectionPlatform' -ErrorAction SilentlyContinue
    $domain = $null; try { $domain = [bool](Cim 'Win32_ComputerSystem').PartOfDomain } catch {}
    [pscustomobject]@{ ArtifactCount = $found.Count; Artifacts = ($found -join ' | '); KmsHost = $spp.KeyManagementServiceName; PartOfDomain = $domain }
}
Section 'activationHistory' {
    # Windows never stores an activation date. The SPP service logs licensing checks (event 1003); the oldest check that
    # already shows an activated Windows SKU is a lower bound, limited by how far back the Application log reaches.
    $all = @()
    try { $all = @(Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Security-SPP'; Id=1003} -ErrorAction Stop | Where-Object { $_.Message -match '55c92734-d682-4d71-983e-d6ec3f16059f' } | Sort-Object TimeCreated) }
    catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }
    $isActive = { param($m) $m -match '(?m)^\d+: [0-9a-fA-F-]{36}, \d+, 1 ' }
    $first = $all | Where-Object { & $isActive $_.Message } | Select-Object -First 1
    $before = if ($first) { $all | Where-Object { $_.TimeCreated -lt $first.TimeCreated -and -not (& $isActive $_.Message) } | Select-Object -Last 1 }
    $oldest = Get-WinEvent -LogName Application -MaxEvents 1 -Oldest -ErrorAction SilentlyContinue
    $iso = { param($e) if ($e) { $e.TimeCreated.ToString('o') } else { $null } }
    [pscustomobject]@{ Checks = $all.Count; FirstActivatedSeen = (& $iso $first); LastNotActivatedBefore = (& $iso $before); LastCheck = (& $iso ($all | Select-Object -Last 1)); LogStartsAt = (& $iso $oldest) }
}
Section 'powerEvents' {
    # Boot / shutdown / sleep / wake / crash events (newest 6000) for the Sử dụng tab; decoded in usage-history.cjs.
    $oldest = Get-WinEvent -LogName System -MaxEvents 1 -Oldest -ErrorAction SilentlyContinue
    [pscustomobject]@{ LogStartsAt = $(if ($oldest) { $oldest.TimeCreated.ToString('o') } else { $null }) }
    $filter = @(
        @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-General'; Id=12,13},
        @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=41,42,107,506,507},
        @{LogName='System'; ProviderName='Microsoft-Windows-Power-Troubleshooter'; Id=1})
    try { Get-WinEvent -FilterHashtable $filter -MaxEvents 6000 -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ Time = $_.TimeCreated.ToString('o'); Provider = $_.ProviderName; Id = $_.Id } } }
    catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }
}
Section 'stability' {
    # Crashes: Kernel-Power 41 = Windows went down without a clean shutdown (BugcheckCode ≠ 0: blue screen; a power
    # button timestamp: the button was held; otherwise power loss / hard hang). WER 1001 = blue screen report with its
    # stop code. WHEA-Logger = hardware errors the CPU / chipset reported (RAM, PCIe, CPU cache).
    $iso = { param($t) $t.ToUniversalTime().ToString('o') }
    $field = { param($e, $name) ([xml]$e.ToXml()).Event.EventData.Data | Where-Object { $_.Name -eq $name } | ForEach-Object { $_.'#text' } }
    $crashes = @(); $bsods = @(); $whea = @(); $systemStart = $null
    try { $systemStart = & $iso (Get-WinEvent -LogName System -Oldest -MaxEvents 1 -ErrorAction Stop).TimeCreated } catch {}
    try { $crashes = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=41} -MaxEvents 500 -ErrorAction Stop | ForEach-Object {
        $bug = [int64](& $field $_ 'BugcheckCode'); $button = [int64](& $field $_ 'PowerButtonTimestamp')
        [pscustomobject]@{ Time = (& $iso $_.TimeCreated); Bugcheck = $(if ($bug) { '0x{0:X}' -f $bug } else { $null }); PowerButton = [bool]$button } }) } catch {}
    try { $bsods = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'; Id=1001} -MaxEvents 200 -ErrorAction Stop | ForEach-Object {
        [pscustomobject]@{ Time = (& $iso $_.TimeCreated); Code = $(if ($_.Message -match '0x[0-9a-fA-F]{8}') { $Matches[0] } else { $null }) } }) } catch {}
    try { $whea = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'} -MaxEvents 500 -ErrorAction Stop | ForEach-Object {
        [pscustomobject]@{ Time = (& $iso $_.TimeCreated); Id = $_.Id; Level = $_.LevelDisplayName } }) } catch {}
    [pscustomobject]@{ SystemLogStart = $systemStart; Crashes = $crashes; BlueScreens = $bsods; Whea = $whea }
}
Section 'memoryDiag' {
    # Results Windows Memory Diagnostic (mdsched) logs after its reboot-time scan of all RAM.
    @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-MemoryDiagnostics-Results'} -MaxEvents 5 -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{ Time = $_.TimeCreated.ToUniversalTime().ToString('o'); Id = $_.Id; Message = (($_.Message -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 2) -join ' ' } })
}
Section 'firstUse' {
    # The first time someone set this Windows up: oldest Setup-log event and the first local profile folder (both made at
    # OOBE), the oldest install date kept across feature updates ("Source OS" keys) and the current install date.
    $epoch = [DateTime]'1970-01-01Z'; $iso = { param($t) $t.ToUniversalTime().ToString('o') }
    $setupStart = $null; try { $setupStart = & $iso (Get-WinEvent -LogName Setup -Oldest -MaxEvents 1 -ErrorAction Stop).TimeCreated } catch {}
    $profiles = @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like 'S-1-5-21-*' } |
        ForEach-Object { (Get-ItemProperty $_.PSPath).ProfileImagePath } | Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
        ForEach-Object { [pscustomobject]@{ Path = $_; Created = (& $iso (Get-Item -LiteralPath $_ -Force).CreationTime) } } | Sort-Object Created)
    $sources = @(Get-ChildItem 'HKLM:\SYSTEM\Setup' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like 'Source OS*' } |
        ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.InstallDate) { & $iso $epoch.AddSeconds($p.InstallDate) } })
    $installed = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue).InstallDate
    [pscustomobject]@{ SetupLogStart = $setupStart; FirstProfile = $(if ($profiles.Count) { $profiles[0].Created } else { $null }); FirstProfileName = $(if ($profiles.Count) { Split-Path $profiles[0].Path -Leaf } else { $null })
        OriginalInstall = $(if ($sources.Count) { ($sources | Sort-Object)[0] } else { $null }); CurrentInstall = $(if ($installed) { & $iso $epoch.AddSeconds($installed) } else { $null }) }
}
Section 'office' {
    # Office licensing (read-only): SPP products of the Office application id, Click-to-Run config, Microsoft 365
    # sign-in licenses, KMS host settings, KMS requests in the SPP log (each names the SKU it was sent for) and the
    # Ohook crack leftover (a fake sppc.dll inside Office's own vfs folder).
    $officeApp = '0ff1ce15-a989-479d-af46-f275c6370663'
    $c2r = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction SilentlyContinue
    $products = @()
    try { $products = @(Get-CimInstance -Query "SELECT ID,Name,Description,LicenseStatus,PartialProductKey,ProductKeyChannel,GracePeriodRemaining,EvaluationEndDate,KeyManagementServiceMachine,DiscoveredKeyManagementServiceMachineName FROM SoftwareLicensingProduct WHERE ApplicationID='$officeApp' AND PartialProductKey IS NOT NULL" -OperationTimeoutSec 30 -ErrorAction Stop) } catch {}
    $kmsReg = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SoftwareProtectionPlatform\$officeApp" -ErrorAction SilentlyContinue).KeyManagementServiceName
    if (-not $kmsReg) { $kmsReg = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\OfficeSoftwareProtectionPlatform' -ErrorAction SilentlyContinue).KeyManagementServiceName }
    $hooks = @("$env:ProgramFiles\Microsoft Office\root\vfs\System\sppc.dll", "$env:ProgramFiles\Microsoft Office\root\vfs\SystemX86\sppc.dll",
        "${env:ProgramFiles(x86)}\Microsoft Office\root\vfs\System\sppc.dll", "${env:ProgramFiles(x86)}\Microsoft Office\root\vfs\SystemX86\sppc.dll") | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    $skus = @($products | ForEach-Object { $_.ID })
    $requests = @()
    try {
        Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Security-SPP'; Id=12288} -MaxEvents 200 -ErrorAction Stop | ForEach-Object {
            if ($_.Message -match ',\s*([\w.\-]+:\d{2,5}),' ) { $hostPort = $Matches[1]
                $sku = ([regex]::Matches($_.Message, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}') | ForEach-Object Value | Where-Object { $skus -contains $_ } | Select-Object -First 1)
                if ($sku) { $requests += "$($_.TimeCreated.ToString('yyyy-MM-dd HH:mm')) $hostPort" } } }
    } catch {}
    $requests = @($requests | Select-Object -First 10)
    [pscustomobject]@{
        Installed = [bool]($c2r -or $products.Count); Version = $c2r.VersionToReport; ReleaseIds = $c2r.ProductReleaseIds; Platform = $c2r.Platform
        M365Licenses = (Test-Path "$env:LOCALAPPDATA\Microsoft\Office\Licenses"); KmsHost = $kmsReg; Hooks = ($hooks -join ' | '); KmsRequests = ($requests -join ' | ')
        Products = @($products | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Channel = $(if ($_.ProductKeyChannel) { $_.ProductKeyChannel } else { $_.Description }); Description = $_.Description; LicenseStatus = [int]$_.LicenseStatus; PartialProductKey = $_.PartialProductKey; GraceMinutes = $_.GracePeriodRemaining; EvaluationEndDate = $(if ($_.EvaluationEndDate -and $_.EvaluationEndDate.Year -gt 1601) { $_.EvaluationEndDate.ToUniversalTime().ToString('o') } else { $null }); KmsMachine = $_.KeyManagementServiceMachine; KmsDiscovered = $_.DiscoveredKeyManagementServiceMachineName } })
    }
}
Section 'mdm' {
    # Device management (read-only): Azure AD / domain join from dsregcmd, real MDM enrollments (Windows keeps many
    # internal ones with no provider, UPN or server, those are skipped), Windows Autopilot registration (a tenant here
    # means a reset still forces the company sign-in) and installed management / anti-theft agents.
    $join = @{}
    try { & "$env:windir\System32\dsregcmd.exe" /status 2>$null | ForEach-Object { if ($_ -match '^\s*(\w+)\s*:\s*(.+?)\s*$') { $join[$Matches[1]] = $Matches[2] } } } catch {}
    $internal = @('Local Authority', 'Deploy Authority', 'Cloud Authority')
    $enrollments = @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
        Where-Object { ($_.ProviderID -and $internal -notcontains $_.ProviderID) -or $_.UPN -or $_.DiscoveryServiceFullURL } |
        ForEach-Object { $server = $(if ($_.DiscoveryServiceFullURL -match '^https?://([^/]+)') { $Matches[1] } else { $null }); (@($_.ProviderID, $_.UPN, $server) | Where-Object { $_ }) -join ' · ' })
    $autopilot = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Provisioning\Diagnostics\Autopilot' -ErrorAction SilentlyContinue
    $agents = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { "$($_.Name) $($_.DisplayName)" -match 'CcmExec|IntuneManagementExtension|^rpcnet|Absolute|NinjaRMM|Kaseya|ManageEngine|LTService|AteraAgent|Datto|Workspace ONE|AirWatch|MobileIron|Ivanti' } | ForEach-Object { $_.DisplayName })
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    [pscustomobject]@{
        AzureAdJoined = ($join.AzureAdJoined -eq 'YES'); DomainJoined = ($join.DomainJoined -eq 'YES' -or $cs.PartOfDomain -eq $true); WorkplaceJoined = ($join.WorkplaceJoined -eq 'YES')
        Domain = $(if ($cs.PartOfDomain) { $cs.Domain } else { $null }); TenantName = $join.TenantName; MdmUrl = $join.MdmUrl
        Enrollments = ($enrollments -join ' | '); AutopilotTenant = $(if ($autopilot.CloudAssignedTenantDomain) { $autopilot.CloudAssignedTenantDomain } elseif ($autopilot.CloudAssignedTenantId) { $autopilot.CloudAssignedTenantId } else { $null })
        AutopilotProfile = $(if ($autopilot.DeploymentProfileName) { $autopilot.DeploymentProfileName } else { $null }); Agents = ($agents -join ' | '); DsregRead = [bool]$join.Count
    }
}
Section 'windowsInfo' {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
    [pscustomobject]@{ EditionID = $cv.EditionID; DisplayVersion = $cv.DisplayVersion; Build = "$($cv.CurrentBuild).$($cv.UBR)"; RegisteredOwner = $cv.RegisteredOwner; RegisteredOrganization = $cv.RegisteredOrganization; ComputerName = $env:COMPUTERNAME }
}
Section 'antivirus' {
    # Defender status plus every product registered in Windows Security Center (third-party antivirus included).
    $rows = @()
    try {
        $mp = Get-MpComputerStatus -ErrorAction Stop
        $rows += [pscustomobject]@{ Name = 'Microsoft Defender'; Enabled = [bool]$mp.AntivirusEnabled; RealTime = [bool]$mp.RealTimeProtectionEnabled; TamperProtected = $mp.IsTamperProtected; SignatureUpdated = $(if ($mp.AntivirusSignatureLastUpdated) { $mp.AntivirusSignatureLastUpdated.ToString('yyyy-MM-dd HH:mm') } else { $null }) }
    } catch {}
    try { Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -OperationTimeoutSec 10 -ErrorAction Stop | Where-Object { $_.displayName -notmatch 'Defender' } | ForEach-Object {
        # productState bits 12-13: 0x1000 = enabled; bits 4-7: 0x10 = signatures out of date.
        $rows += [pscustomobject]@{ Name = $_.displayName; Enabled = [bool]($_.productState -band 0x1000); RealTime = $null; TamperProtected = $null; SignatureUpdated = $(if ($_.productState -band 0x10) { 'Cũ' } else { 'Mới' }) } } } catch {}
    $rows
}
Section 'accounts' {
    # Local accounts left on the machine (e.g. the previous owner's); admin membership by the well-known SID.
    $admins = @(); try { $admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { ($_.Name -split '\\')[-1] }) } catch {}
    Get-LocalUser -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Enabled = [bool]$_.Enabled; Admin = $admins -contains $_.Name; LastLogon = $(if ($_.LastLogon) { $_.LastLogon.ToString('yyyy-MM-dd HH:mm') } else { $null }); PasswordRequired = [bool]$_.PasswordRequired; Description = $_.Description } }
}
Section 'hotfixes' {
    Get-HotFix -ErrorAction Stop | Sort-Object InstalledOn -Descending | Select-Object -First 15 HotFixID, Description, @{n='InstalledOn';e={ if ($_.InstalledOn) { $_.InstalledOn.ToString('yyyy-MM-dd') } }}
}
Section 'gpu' { Cim 'Win32_VideoController' | Select-Object Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate,VideoModeDescription }
Section 'battery' {
    $temp = Join-Path ([IO.Path]::GetTempPath()) ('test-tool-battery-' + [guid]::NewGuid().ToString('N') + '.xml')
    try {
        $p = Start-Process -FilePath "$env:SystemRoot/System32/powercfg.exe" -ArgumentList @('/batteryreport','/xml','/output',('"' + $temp + '"')) -WindowStyle Hidden -PassThru
        if (-not $p.WaitForExit(15000)) { $p.Kill(); throw 'powercfg timed out (15s)' }
        if ($p.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $temp)) { throw 'Windows không cung cấp báo cáo pin. Có thể không có pin hoặc cần quyền quản trị.' }
        [xml]$xml = Get-Content -LiteralPath $temp -Raw
        # powercfg often leaves CycleCount empty; root/wmi BatteryCycleCount is the fallback (same order as the report).
        $wmiCycles = @()
        try { $wmiCycles = @(Get-CimInstance -Namespace root/wmi -ClassName BatteryCycleCount -OperationTimeoutSec 4 -ErrorAction Stop | ForEach-Object { $_.CycleCount }) } catch {}
        $i = 0
        foreach ($b in $xml.BatteryReport.Batteries.Battery) {
            if ($null -ne $b) {
                $cycles = [string]$b.CycleCount; $cycleSource = 'powercfg'
                if (-not $cycles -and $i -lt $wmiCycles.Count) { $cycles = [string]$wmiCycles[$i]; $cycleSource = 'root/wmi' }
                [pscustomobject]@{ Name=[string]$b.Id; Manufacturer=[string]$b.Manufacturer; ManufactureDate=[string]$b.ManufactureDate; Chemistry=[string]$b.Chemistry; DesignCapacity=[string]$b.DesignCapacity; FullChargeCapacity=[string]$b.FullChargeCapacity; CycleCount=$cycles; CycleSource=$(if ($cycles) {$cycleSource} else {$null}) }
                $i++
            }
        }
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
Section 'batteryNow' { Cim 'Win32_Battery' | Select-Object Name,EstimatedChargeRemaining,BatteryStatus }
Section 'disks' { Cim 'Win32_DiskDrive' | Select-Object Index,Model,Size,InterfaceType,Status,MediaType,SerialNumber }
Section 'volumes' { Cim 'Win32_LogicalDisk' | Where-Object {$_.DriveType -eq 3} | Select-Object DeviceID,VolumeName,Size,FreeSpace,FileSystem }
# Drive health read straight from the storage driver (NVMe health log, ATA identify / Device Statistics / SMART).
Section 'smartRaw' { . (Join-Path $PSScriptRoot 'smart.ps1'); Get-DiskSmart }
Section 'network' { Cim 'Win32_NetworkAdapter' | Where-Object {$_.PhysicalAdapter} | Select-Object Name,NetConnectionID,NetConnectionStatus,Speed,MACAddress }
Section 'audio' { Cim 'Win32_SoundDevice' | Select-Object Name,Status,ConfigManagerErrorCode }
Section 'devices' { PnP | Where-Object {$_.PNPClass -in @('Camera','Image','Bluetooth','Monitor') -or ($null -ne $_.ConfigManagerErrorCode -and $_.ConfigManagerErrorCode -ne 0)} | Select-Object Name,PNPClass,Status,ConfigManagerErrorCode }
Section 'events' {
    # No matching events is an empty result, not a healthy-hardware verdict.
    try {
        Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddDays(-7); Id=@(7,51,55,129,153,17,18,19,41)} -MaxEvents 80 -ErrorAction Stop |
        Where-Object {$_.ProviderName -match 'disk|stor|Ntfs|WHEA|Kernel-Power'} |
        Select-Object TimeCreated,Id,ProviderName,LevelDisplayName,Message
    } catch {
        if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
    }
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
