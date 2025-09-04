# CDC Cheatsheet: MySQL → Kafka → PostgreSQL (users mirror)

This file contains copy‑paste commands to create and verify the end‑to‑end pipeline that mirrors the MySQL `aiatwork.users` table into Postgres `user_mysql_mirror` using Debezium and JDBC Sink.

Notes:
- These commands assume the Docker Compose service names: `mysql`, `kafka`, `connect`, and `db` (Postgres).
- Run commands from the host (macOS) terminal in this project folder.
- JSON payloads must NOT contain comments.

---

## 0) Quick health and plugins

```bash
curl -s http://localhost:8083/connectors | jq
curl -s http://localhost:8083/connector-plugins | jq
```

You should see plugins like `io.debezium.connector.mysql.MySqlConnector` and `io.confluent.connect.jdbc.JdbcSinkConnector`.

---

## 1) (Optional) Clean up any prior connectors

```bash
curl -s -X DELETE http://localhost:8083/connectors/mysql-aiatwork-source
curl -s -X DELETE http://localhost:8083/connectors/pg-users-sink
```

---

## 2) Create Debezium MySQL source (users)

```bash
curl -sS -X POST http://localhost:8083/connectors \
  -H 'Content-Type: application/json' -d '{
  "name": "mysql-aiatwork-source",
  "config": {
    "connector.class": "io.debezium.connector.mysql.MySqlConnector",
    "tasks.max": "1",
    "database.hostname": "mysql",
    "database.port": "3306",
    "database.user": "ai_cdc",
    "database.password": "ai_cdc_pwd",
    "database.server.id": "184054",
    "database.include.list": "aiatwork",
    "table.include.list": "aiatwork.users",
    "topic.prefix": "mysql",
    "include.schema.changes": "false",
    "tombstones.on.delete": "false",
    "decimal.handling.mode": "string",
    "time.precision.mode": "connect",
    "snapshot.mode": "initial",
    "schema.history.internal.kafka.bootstrap.servers": "kafka:9092",
    "schema.history.internal.kafka.topic": "schemahistory.aiatwork",
    "key.converter": "org.apache.kafka.connect.json.JsonConverter",
    "key.converter.schemas.enable": "true",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "true"
  }
}'
```

Status:
```bash
curl -s http://localhost:8083/connectors/mysql-aiatwork-source/status | jq
```

---

## 3) Create JDBC sink → Postgres table `user_mysql_mirror`

```bash
curl -sS -X POST http://localhost:8083/connectors \
  -H 'Content-Type: application/json' -d '{
  "name": "pg-users-sink",
  "config": {
    "connector.class": "io.confluent.connect.jdbc.JdbcSinkConnector",
    "tasks.max": "1",
    "topics": "mysql.aiatwork.users",
    "connection.url": "jdbc:postgresql://db:5432/compenion_ai",
    "connection.user": "compenion_ai",
    "connection.password": "compenion_ai",
    "auto.create": "true",
    "auto.evolve": "true",
    "insert.mode": "upsert",
    "pk.mode": "record_value",
    "pk.fields": "id",
    "delete.enabled": "false",
    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "true",
    "table.name.format": "user_mysql_mirror",
    "consumer.override.auto.offset.reset": "earliest"
  }
}'
```

Status:
```bash
curl -s http://localhost:8083/connectors/pg-users-sink/status | jq
```

---

## 4) Kafka checks (topic + sample events)

```bash
docker exec -it compenion_ai_kafka bash -lc "kafka-topics --bootstrap-server localhost:9092 --list | grep ^mysql\\.aiatwork\\.users$"

docker exec -it compenion_ai_kafka bash -lc "kafka-console-consumer --bootstrap-server localhost:9092 --from-beginning --timeout-ms 5000 --topic mysql.aiatwork.users | head -n 5"
```

If no events appear, trigger one from MySQL (replace YOUR_EMAIL):
```bash
docker exec -it compenion_ai_mysql bash -lc "mysql -uroot -prootpwd -e \"USE aiatwork; UPDATE users SET updated_at=NOW() WHERE email='YOUR_EMAIL';\""
```

---

## 5) Postgres verification (mirror table)

```bash
docker exec -it compenion_ai_pg bash -lc "psql -U compenion_ai -d compenion_ai -c \"SELECT id, name, email, updated_at FROM user_mysql_mirror ORDER BY id DESC LIMIT 10;\""
```

---

## 6) Troubleshooting helpers

Connector list and statuses:
```bash
curl -s http://localhost:8083/connectors | jq
curl -s http://localhost:8083/connectors/mysql-aiatwork-source/status | jq
curl -s http://localhost:8083/connectors/pg-users-sink/status | jq
```

Restart a task (example for sink task 0):
```bash
curl -s -X POST http://localhost:8083/connectors/pg-users-sink/tasks/0/restart
```

Connect logs (tail):
```bash
docker logs --tail=300 compenion_ai_connect | sed -n '/mysql-aiatwork-source/,$p'
docker logs --tail=300 compenion_ai_connect | sed -n '/pg-users-sink/,$p'
```

Remove connectors:
```bash
curl -s -X DELETE http://localhost:8083/connectors/mysql-aiatwork-source
curl -s -X DELETE http://localhost:8083/connectors/pg-users-sink
```


