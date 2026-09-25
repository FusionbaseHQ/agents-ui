# Hostile-but-realistic sshd for the SSH file browser e2e test: a tcsh login
# shell, a .bashrc that prints noise, and a quiet account for scp/SFTP.
FROM debian:stable-slim
RUN apt-get update -qq && apt-get install -y -qq openssh-server tcsh >/dev/null && mkdir -p /run/sshd
RUN useradd -m -s /usr/bin/tcsh tcshuser && useradd -m -s /bin/bash bashuser && useradd -m -s /bin/sh quietuser
COPY id_test.pub /tmp/key.pub
RUN for u in tcshuser bashuser quietuser; do mkdir -p /home/$u/.ssh && cp /tmp/key.pub /home/$u/.ssh/authorized_keys && chown -R $u /home/$u/.ssh && chmod 700 /home/$u/.ssh; done \
 && echo 'echo "NOISE from tcshrc"' > /home/tcshuser/.tcshrc \
 && printf 'echo "NOISE from bashrc"\n' > /home/bashuser/.bashrc \
 && mkdir -p "/home/bashuser/proj/src" && printf 'hello\n' > "/home/bashuser/proj/src/a.txt" \
 && mkdir -p "/home/tcshuser/proj" && printf 'tc\n' > "/home/tcshuser/proj/t.txt" \
 && mkdir -p "/home/quietuser/proj" && printf 'quiet\n' > "/home/quietuser/proj/q.txt" \
 && chown -R bashuser /home/bashuser && chown -R tcshuser /home/tcshuser && chown -R quietuser /home/quietuser
EXPOSE 22
CMD ["/usr/sbin/sshd","-D","-e"]
