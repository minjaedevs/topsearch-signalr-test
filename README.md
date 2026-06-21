# TopSearch SignalR Test Server

Server Node.js tối giản để test `SignalRClient.kt` của app Android.
Không cần cài dependency ngoài.

## Chạy server

```powershell
cd D:\sports_data\topsearch-signalr-test
npm start
```

Mặc định server chạy:

```text
ws://localhost:5088/hubs/mobile-check?secret=ds-socket-9k3m7x2q5w8e1r4t6y0u
```

Nếu test bằng điện thoại thật cùng mạng LAN, đổi `localhost` trong app thành IP máy tính, ví dụ:

```text
ws://192.168.1.10:5088/hubs/mobile-check?secret=ds-socket-9k3m7x2q5w8e1r4t6y0u
```

Android emulator có thể dùng:

```text
ws://10.0.2.2:5088/hubs/mobile-check?secret=ds-socket-9k3m7x2q5w8e1r4t6y0u
```

Trong app Android, bản `debug` đã được cấu hình sẵn để connect URL emulator này qua `BuildConfig.SOCKET_URL`.
Nếu test bằng điện thoại thật, đổi `SOCKET_URL` debug trong `app/build.gradle.kts` sang IP máy tính trong LAN.

Ví dụ:

```text
ws://192.168.1.10:5088/hubs/mobile-check?secret=ds-socket-9k3m7x2q5w8e1r4t6y0u
```

## Kiểm tra server đang sống

```powershell
Invoke-RestMethod http://localhost:5088/
Invoke-RestMethod http://localhost:5088/clients
```

## Gửi batch keyword test qua API

```powershell
$body = @(
  @{ requestId = "req-001"; keyword = "new88"; proxy = "host:port:user:pass"; country = 1 },
  @{ requestId = "req-002"; keyword = "jun88"; proxy = "host:port:user:pass"; country = 1 }
) | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri http://localhost:5088/check-keywords -ContentType 'application/json' -Body $body
```

API này sẽ emit qua WebSocket đúng event `CheckKeywords`:

```json
{
  "type": 1,
  "target": "CheckKeywords",
  "arguments": [[
    { "requestId": "req-001", "keyword": "new88", "proxy": "host:port:user:pass", "country": 1 }
  ]]
}
```

Alias tương đương nếu muốn gõ ngắn:

```text
POST /send
POST /emit
```

## Xem mobile đang connect

```powershell
Invoke-RestMethod http://localhost:5088/clients
```

## Xem kết quả mobile submit

```powershell
Invoke-RestMethod http://localhost:5088/results
```

Khi mobile gửi `SubmitMobileResult`, server sẽ log payload đầy đủ ra terminal và lưu vào `/results`.
Mobile phải gửi đúng 1 object trong `arguments`:

```json
{
  "requestId": "req-001",
  "items": [{ "top": 1, "url": "https://abc.com/", "domain": "abc.com" }],
  "mobileImageUrl": "https://.../file.jpg",
  "publicIp": "117.5.220.204",
  "sourceName": "samsung SM-S908U1 (...)"
}
```
