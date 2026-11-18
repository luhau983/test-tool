$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BatteryPower {
    [StructLayout(LayoutKind.Sequential)]
    public struct Status {
        public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
        public UInt32 BatteryLifeTime, BatteryFullLifeTime;
    }
    [DllImport("kernel32.dll")]
    private static extern bool GetSystemPowerStatus(out Status status);
    public static Status Read() {
        Status value;
        if(!GetSystemPowerStatus(out value)) throw new Exception("GetSystemPowerStatus failed");
        return value;
    }
}
'@
$power=[BatteryPower]::Read()
$details=@();$detailError=$null
try {
    $details=@(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -OperationTimeoutSec 4 -ErrorAction Stop |
        Select-Object InstanceName,PowerOnline,Charging,Discharging,Critical,Voltage,RemainingCapacity,ChargeRate,DischargeRate)
} catch {$detailError=$_.Exception.Message}
[ordered]@{
    at=(Get-Date).ToUniversalTime().ToString('o')
    source='GetSystemPowerStatus + root/wmi BatteryStatus'
    hasBattery=$(if($power.BatteryFlag -eq 255){$null}else{($power.BatteryFlag -band 128) -eq 0})
    percent=$(if($power.BatteryLifePercent -le 100){[int]$power.BatteryLifePercent}else{$null})
    ac=$(if($power.ACLineStatus -eq 0){'offline'}elseif($power.ACLineStatus -eq 1){'online'}else{'unknown'})
    charging=$(if($power.BatteryFlag -eq 255){$null}else{($power.BatteryFlag -band 8) -ne 0})
    batterySaver=($power.SystemStatusFlag -eq 1)
    windowsSecondsRemaining=$(if($power.BatteryLifeTime -eq [uint32]::MaxValue){$null}else{$power.BatteryLifeTime})
    details=$details
    detailError=$detailError
} | ConvertTo-Json -Depth 5 -Compress
