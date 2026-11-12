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
        choice(name: 'DEPLOY_METHOD', choices: ['LOCAL', 'NONE'], description: 'LOCAL: deploy on this server, 192.168.0.230, where Jenkins runs (default); NONE: build only')
        string(name: 'APP_PORT', defaultValue: '8089', description: 'Порт публикации Retrace на сервере 192.168.0.230')
    }

    environment {
        // Конфигурация локального реестра
        REGISTRY_IP    = "192.168.0.222"
        REGISTRY_PORT  = "5050"

        DOCKER_IMAGE   = "${REGISTRY_IP}:${REGISTRY_PORT}/retrace"

        // Retrace работает на том же сервере, что и Jenkins (192.168.0.230): публикация локальная, без SSH.
        // Там же PostgreSQL (база retrace).
        PROD_SERVER_IP = "192.168.0.230"

        DEPLOY_DIR     = "/opt/retrace"
        CONTAINER_NAME = "retrace_app"
    }

    stages {
        stage('Source Checkout') {
            steps {
                fixWorkspacePermissions()
                sh 'rm -rf node_modules dist tsconfig.tsbuildinfo'
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

        stage('Deploy (local)') {
            when { expression { params.DEPLOY_METHOD == 'LOCAL' } }
            steps {
                script {
                    def appPort = params.APP_PORT?.trim() ?: '8089'
                    echo "Публикация в Docker на этом сервере (${PROD_SERVER_IP}:${appPort})..."
                    sh """
                    sudo mkdir -p ${DEPLOY_DIR}/data/uploads
                    sudo chown -R \$(id -un):\$(id -gn) ${DEPLOY_DIR}

                    # Секреты (DATABASE_URL, токен бота, почта) живут только на сервере:
                    # создаём пустой файл, если его нет, и никогда не перезаписываем
                    touch ${DEPLOY_DIR}/secrets.env && chmod 600 ${DEPLOY_DIR}/secrets.env

                    cp docker-compose.yml ${DEPLOY_DIR}/
                    printf 'DOCKER_IMAGE=%s\\nCONTAINER_NAME=%s\\nAPP_PORT=%s\\n' '${DOCKER_IMAGE}:latest' '${CONTAINER_NAME}' '${appPort}' > ${DEPLOY_DIR}/.env
                    cd ${DEPLOY_DIR} && docker compose pull && docker compose up -d --remove-orphans
                    """
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
