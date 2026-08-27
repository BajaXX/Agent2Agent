#!/usr/bin/env bash
set -u
B="http://127.0.0.1:3081/api/v1"
PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1: expect [$2] got [$3]"; fi }

echo "== 1. 注册 =="
R1=$(curl -sX POST $B/register -H 'Content-Type: application/json' -d '{"name":"project-A","tool":"cursor","projectName":"A 项目","description":"A 项目开发","capabilities":["开发"],"tech":["React"]}')
TA=$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
chk "register A" "tk_" "${TA:0:3}"
R2=$(curl -sX POST $B/register -H 'Content-Type: application/json' -d '{"name":"project-B","tool":"cursor","projectName":"B 项目","description":"用户中心后端","capabilities":["开发","API 提供"],"tech":["Node.js"]}')
TB=$(echo "$R2" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
chk "register B" "tk_" "${TB:0:3}"
chk "重复注册 409" "409" "$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/register -H 'Content-Type: application/json' -d '{"name":"project-A","tool":"cursor","projectName":"dup"}')"

echo "== 2. 目录/心跳 =="
chk "agents=2" "2" "$(curl -s $B/agents | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")"
HB=$(curl -s -X POST $B/heartbeat -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"status":"working","note":"处理中"}')
chk "heartbeat online" "True" "$(echo "$HB" | python3 -c "import sys,json;print(json.load(sys.stdin)['online'])")"
chk "agents A online" "True" "$(curl -s $B/agents | python3 -c "import sys,json;print([a for a in json.load(sys.stdin) if a['name']=='project-A'][0]['online'])")"

echo "== 3. 消息 =="
M1=$(curl -s -X POST $B/messages -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"to":"project-B","subject":"需要 B 的 API 清单","body":"请尽快提供 API 文档","needsReply":true,"priority":"high"}')
MID=$(echo "$M1" | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'])")
chk "发送消息" "m_" "${MID:0:2}"
chk "B 未读=1" "1" "$(curl -s "$B/messages?dir=in&status=unread" -H "Authorization: Bearer $TB" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['items']))")"
chk "未授权 401" "401" "$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/messages -H 'Content-Type: application/json' -d '{"to":"project-A","subject":"x","body":"y"}')"
chk "发给不存在账号 404" "404" "$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/messages -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"to":"nobody","subject":"x","body":"y"}')"
RPL=$(curl -s -X POST $B/messages/$MID/reply -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"body":"API 清单：/api/v1/users"}')
chk "回复" "m_" "$(echo "$RPL" | python3 -c "import sys,json;print(json.load(sys.stdin)['messageId'][:2])")"
chk "原消息变 read" "read" "$(curl -s $B/messages/$MID | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")"
ST=$(curl -s -X POST $B/messages/$MID/status -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"status":"resolved"}')
chk "标记 resolved" "resolved" "$(echo "$ST" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")"
chk "非收件方标记 403" "403" "$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/messages/$MID/status -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"status":"read"}')"
chk "回复链 replyTo" "$MID" "$(curl -s "$B/messages?dir=in" -H "Authorization: Bearer $TA" | python3 -c "import sys,json;print([m for m in json.load(sys.stdin)['items'] if m.get('replyTo')][0]['replyTo'])")"

echo "== 4. 任务 =="
T1=$(curl -s -X POST $B/tasks -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"title":"实现用户 API","description":"REST /api/v1/users","priority":"high"}')
TID=$(echo "$T1" | python3 -c "import sys,json;print(json.load(sys.stdin)['taskId'])")
chk "创建任务" "t_" "${TID:0:2}"
chk "置 doing" "doing" "$(curl -s -X PATCH $B/tasks/$TID -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"status":"doing"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")"
chk "置 done" "done" "$(curl -s -X PATCH $B/tasks/$TID -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"status":"done","note":"完成"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")"
chk "他人无权更新 403" "403" "$(curl -s -o /dev/null -w "%{http_code}" -X PATCH $B/tasks/$TID -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"status":"todo"}')"
chk "blocked 需说明 400" "400" "$(curl -s -o /dev/null -w "%{http_code}" -X PATCH $B/tasks/$TID -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"status":"blocked"}')"

echo "== 5. 文档 =="
echo "# 需求文档" > /tmp/需求.md
echo "- 用户中心" >> /tmp/需求.md
DOC=$(curl -s -X POST $B/documents -H "Authorization: Bearer $TA" -F "file=@/tmp/需求.md" -F "description=测试需求")
DID=$(echo "$DOC" | python3 -c "import sys,json;print(json.load(sys.stdin)['document']['id'])")
chk "上传文档" "d_" "${DID:0:2}"
chk "列表=1" "1" "$(curl -s $B/documents | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")"
chk "预览含内容" "1" "$(curl -s "$B/documents/$DID/content?inline=1" | grep -c 需求文档)"
chk "文档元数据 sha256" "64" "$(curl -s $B/documents/$DID | python3 -c "import sys,json;print(len(json.load(sys.stdin)['sha256']))")"

echo "== 6. 双向 sync =="
RC=$(curl -sX POST $B/register -H 'Content-Type: application/json' -d '{"name":"sync-C","tool":"dsh","projectName":"C 项目","description":"sync 测试","capabilities":["预研"],"tech":["Python"]}')
TC=$(echo "$RC" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
mkdir -p /tmp/syncdir && cd /tmp/syncdir
echo "接口文档 v1" > api.md; echo "笔记" > notes.txt
RESP=$(curl -s -X POST $B/sync -H "Authorization: Bearer $TC" -F "files=@api.md" -F "files=@notes.txt" -F 'manifest=[{"name":"api.md","mtime":1787809000000},{"name":"notes.txt","mtime":1787809000000}]')
chk "sync 推送 2 文件" "2" "$(echo "$RESP" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['pushed']))")"
PULL=$(curl -s "$B/sync?since=0" -H "Authorization: Bearer $TC")
chk "sync 拉取含 api.md" "api.md" "$(echo "$PULL" | python3 -c "import sys,json;print([x['name'] for x in json.load(sys.stdin)['changes'] if x['name']=='api.md'][0])")"
chk "拉取内联 content base64" "base64" "$(echo "$PULL" | python3 -c "import sys,json;c=[x for x in json.load(sys.stdin)['changes'] if x['name']=='api.md'][0];print('base64' if c['content'] else 'no')")"
RESPDEL=$(curl -s -X POST $B/sync -H "Authorization: Bearer $TC" -H 'Content-Type: application/json' -d '{"deletes":["notes.txt"]}')
chk "sync 删除(JSON body)" "notes.txt" "$(echo "$RESPDEL" | python3 -c "import sys,json;print(json.load(sys.stdin)['deleted'][0])")"
echo "接口文档 v2 本地改" > api.md
RESPCONF=$(curl -s -X POST $B/sync -H "Authorization: Bearer $TC" -F "files=@api.md" -F 'manifest=[{"name":"api.md","mtime":1}]')
chk "旧 mtime 冲突副本" "conflict" "$(echo "$RESPCONF" | python3 -c "import sys,json;d=json.load(sys.stdin);print('conflict' if d.get('conflicts') else 'none')")"
RESPOK=$(curl -s -X POST $B/sync -H "Authorization: Bearer $TC" -F "files=@api.md" -F 'manifest=[{"name":"api.md","mtime":9999999999999}]')
chk "新 mtime 覆盖" "0" "$(echo "$RESPOK" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['conflicts']))")"
RESPDEL2=$(curl -s -X POST $B/sync -H "Authorization: Bearer $TC" -F 'deletes=["api.md"]')
chk "sync 删除(multipart 字段)" "api.md" "$(echo "$RESPDEL2" | python3 -c "import sys,json;print(json.load(sys.stdin)['deleted'][0])")"

echo "== 7. 记忆 =="
chk "初始 version=0" "0" "$(curl -s $B/memory -H "Authorization: Bearer $TA" | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])")"
chk "PUT v1" "1" "$(curl -s -X PUT $B/memory -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"content":"# A 项目记忆","version":0}' | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])")"
chk "旧版本 409" "409" "$(curl -s -o /dev/null -w "%{http_code}" -X PUT $B/memory -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"content":"x","version":0}')"
chk "版本历史=1" "1" "$(curl -s "$B/memory/versions?account=project-A" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")"

echo "== 8. checkin =="
CI=$(curl -s "$B/checkin?since=0" -H "Authorization: Bearer $TB")
chk "checkin 收件箱 items=1" "1" "$(echo "$CI" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['inbox']['items']))")"
chk "checkin 待办 todoTasks=0" "0" "$(echo "$CI" | python3 -c "import sys,json;print(json.load(sys.stdin)['pending']['todoTasks'])")"
chk "checkin 记忆摘要" "content" "$(echo "$CI" | python3 -c "import sys,json;print('content' if 'content' in json.load(sys.stdin)['memory'] else 'no')")"

echo "== 9. summary =="
SUM=$(curl -s $B/summary)
chk "summary agents=3" "3" "$(echo "$SUM" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['agents']))")"
chk "summary needsReplyPending=0" "0" "$(echo "$SUM" | python3 -c "import sys,json;print(json.load(sys.stdin)['needsReplyPending'])")"
chk "summary recentActivity>0" "True" "$(echo "$SUM" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['recentActivity'])>0)")"

echo "== 10. 幂等 =="
ID1=$(curl -s -X POST $B/tasks -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -H 'Idempotency-Key: k1' -d '{"title":"幂等任务"}')
ID2=$(curl -s -X POST $B/tasks -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -H 'Idempotency-Key: k1' -d '{"title":"幂等任务"}')
chk "幂等键同 taskId" "$(echo "$ID1" | python3 -c "import sys,json;print(json.load(sys.stdin)['taskId'])")" "$(echo "$ID2" | python3 -c "import sys,json;print(json.load(sys.stdin)['taskId'])")"

echo "== 11. SSE 广播 =="
timeout 4 curl -sN "$B/events" > /tmp/sse.out & SSERPID=$!
sleep 0.5
curl -s -X POST $B/messages -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"to":"sync-C","subject":"SSE 测试","body":"hi"}' > /dev/null
sleep 1
kill $SSERPID 2>/dev/null
chk "SSE 收到 message 事件" "message" "$(grep -o 'event: message' /tmp/sse.out | head -1 | sed 's/event: //')"
chk "SSE payload 含 subject" "SSE 测试" "$(grep -o '"subject":"[^"]*"' /tmp/sse.out | head -1 | sed 's/"subject":"//;s/"//')"

echo "== 12. 看板只读接口（无 token） =="
chk "无 token 看 summary" "200" "$(curl -s -o /dev/null -w "%{http_code}" $B/summary)"
chk "无 token 看 tasks" "200" "$(curl -s -o /dev/null -w "%{http_code}" $B/tasks)"
chk "无 token 看 messages" "200" "$(curl -s -o /dev/null -w "%{http_code}" $B/messages)"
chk "无 token 看文档内容" "200" "$(curl -s -o /dev/null -w "%{http_code}" "$B/documents/$DID/content")"
chk "无 token 上传 401" "401" "$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/documents -F "file=@/tmp/需求.md")"

echo ""
echo "======== PASS=$PASS FAIL=$FAIL ========"
