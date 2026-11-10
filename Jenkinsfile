// Shared steps (fixWorkspacePermissions, removeRootOwnedPaths ...): github sergesvalov/jenkins-shared-library, set up in Jenkins as mylib.
@Library('mylib@main') _

pipeline {
    agent { label 'built-in' }

    options {
        disableConcurrentBuilds()
        // The checkout is done in the 'Source Checkout' stage, after fixing file ownership.
        skipDefaultCheckout()
    }

    // A push to main builds and deploys by itself: Jenkins looks at the repository every 5 minutes.
    triggers {
        pollSCM('H/5 * * * *')
    }

    parameters {
        // The first choice is the default, also for builds started by a push.
        choice(name: 'DEPLOY_METHOD', choices: ['DIRECT_SSH', 'NONE'], description: 'DIRECT_SSH: deploy to 192.168.0.225 over SSH (default); NONE: build only')
        string(name: 'APP_PORT', defaultValue: '8089', description: 'Порт публикации Retrace на сервере 192.168.0.225')
    }

    environment {
        // Конфигурация локального реестра
        REGISTRY_IP    = "192.168.0.222"
        REGISTRY_PORT  = "5050"

        DOCKER_IMAGE   = "${REGISTRY_IP}:${REGISTRY_PORT}/retrace"

        // Сервер для публикации в Docker (192.168.0.225)
        PROD_SERVER_IP = "192.168.0.225"
        // Имя пользователя (credentials ID), которое используется в sshagent
        DEPLOY_USER    = "${env.SERVER_USER ?: 'jenkins'}"

        DEPLOY_DIR     = "/opt/retrace"
        CONTAINER_NAME = "retrace_app"
    }

    stages {
        stage('Source Checkout') {
            steps {
                // Hand any root-owned files in the workspace back to jenkins before checkout.
                fixWorkspacePermissions()
                retry(3) {
                    checkout scm
                }
            }
        }

        stage('Build & Test Docker Image') {
            steps {
                script {
                    echo "Сборка и тестирование образа Retrace (typecheck + vitest + vite + esbuild)..."
                    sh "docker build -t ${DOCKER_IMAGE}:latest -f Dockerfile ."
                }
            }
        }

        stage('Push to Registry') {
            steps {
                script {
                    echo "Отправка образа в локальный реестр ${REGISTRY_IP}:${REGISTRY_PORT}..."
                    retry(3) {
                        sh "docker push ${DOCKER_IMAGE}:latest"
                    }
                }
            }
        }

        stage('Deploy to Prod (Direct SSH)') {
            when { expression { params.DEPLOY_METHOD == 'DIRECT_SSH' } }
            steps {
                script {
                    def appPort = params.APP_PORT?.trim() ?: '8089'
                    echo "Публикация в Docker на сервер ${PROD_SERVER_IP}:${appPort} (напрямую через SSH)..."
                    sshagent(credentials: [env.DEPLOY_USER]) {
                        sh """
                        # Создаем папку на целевом сервере 192.168.0.225
                        ssh -o StrictHostKeyChecking=no ${env.DEPLOY_USER}@${PROD_SERVER_IP} "sudo mkdir -p ${DEPLOY_DIR}/data/events ${DEPLOY_DIR}/data/uploads && sudo chown -R ${env.DEPLOY_USER}:${env.DEPLOY_USER} ${DEPLOY_DIR}"

                        # Копируем docker-compose.yml
                        scp -o StrictHostKeyChecking=no docker-compose.yml ${env.DEPLOY_USER}@${PROD_SERVER_IP}:${DEPLOY_DIR}/

                        # Записываем .env и перезапускаем контейнер
                        ssh -o StrictHostKeyChecking=no ${env.DEPLOY_USER}@${PROD_SERVER_IP} "printf 'DOCKER_IMAGE=%s\\nCONTAINER_NAME=%s\\nAPP_PORT=%s\\n' '${DOCKER_IMAGE}:latest' '${CONTAINER_NAME}' '${appPort}' > ${DEPLOY_DIR}/.env && cd ${DEPLOY_DIR} && docker compose pull && docker compose up -d --remove-orphans"
                        """
                    }
                }
            }
        }
    }

    post {
        success {
            echo "Успешное завершение пайплайна Retrace! Опубликовано на http://${PROD_SERVER_IP}:${params.APP_PORT ?: '8089'} 🎉"
        }
        failure {
            echo "Сборка или публикация завершилась с ошибкой. Проверьте логи."
        }
    }
}
