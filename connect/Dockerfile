FROM confluentinc/cp-kafka-connect:7.6.1
RUN confluent-hub install --no-prompt debezium/debezium-connector-postgresql:2.5.3
RUN confluent-hub install --no-prompt confluentinc/kafka-connect-jdbc:10.7.6
# Add MySQL Connector/J (required by JDBC sink)
RUN curl -L -o /usr/share/confluent-hub-components/confluentinc-kafka-connect-jdbc/lib/mysql-connector-j-8.4.0.jar \
  https://repo1.maven.org/maven2/com/mysql/mysql-connector-j/8.4.0/mysql-connector-j-8.4.0.jar
