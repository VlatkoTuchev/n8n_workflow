# ======================================================================================
# Kafka Connect image with JDBC sink and Debezium MySQL source
# - Installs JDBC connector (Confluent) and MySQL Connector/J
# - Adds Debezium MySQL connector from Maven Central
# ======================================================================================
FROM confluentinc/cp-kafka-connect:7.6.1
RUN confluent-hub install --no-prompt confluentinc/kafka-connect-jdbc:10.7.6
# Add MySQL Connector/J (required by JDBC sink)
RUN curl -L -o /usr/share/confluent-hub-components/confluentinc-kafka-connect-jdbc/lib/mysql-connector-j-8.4.0.jar \
  https://repo1.maven.org/maven2/com/mysql/mysql-connector-j/8.4.0/mysql-connector-j-8.4.0.jar

# Add Debezium MySQL connector directly from Maven Central (Confluent Hub may not have this version)
RUN curl -L -o /tmp/debezium-mysql.tgz \
  https://repo1.maven.org/maven2/io/debezium/debezium-connector-mysql/2.5.3.Final/debezium-connector-mysql-2.5.3.Final-plugin.tar.gz \
  && mkdir -p /usr/share/confluent-hub-components/debezium-connector-mysql \
  && tar -xzf /tmp/debezium-mysql.tgz -C /usr/share/confluent-hub-components/debezium-connector-mysql --strip-components=1 \
  && rm /tmp/debezium-mysql.tgz
