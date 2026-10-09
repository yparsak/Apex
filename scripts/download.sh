#!/bin/bash

APP_NAME="Apex"
APP_OWNER="yparsak"
SRC_PATH="${HOME}/src"
APP_PATH="${SRC_PATH}/${APP_NAME}"

GIT_REPO="https://github.com"
GIT_API="https://api.github.com/repos"

APP_REPO_URL="$GIT_REPO/${APP_OWNER}/${APP_NAME}/${APP_NAME}.git"
APP_API_URL="$GIT_API/${APP_OWNER}/${APP_NAME}/releases/latest"

mkdir -p "${SRC_PATH}"
mkdir -p "${APP_PATH}"

RESPONSE=$(curl -sL $APP_API_URL)
DOWNLOAD_URL=$(echo "$RESPONSE" | grep -oP '"tarball_url":\s*"\K[^"]+')
TAG_NAME=$(echo "$RESPONSE" | grep -oP '"tag_name":\s*"\K[^"]+')

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error: Could not parse the download URL. Check your connection or GitHub API limits."
  exit 1
fi

echo "Downloading $DOWNLOAD_URL Tag: $TAG_NAME"
FILENAME="$APP_NAME-$TAG_NAME.tar.gz"
FULL_PATH="$APP_PATH/$FILENAME"

curl -L "$DOWNLOAD_URL" -o "$FULL_PATH"

if [ -f "$FULL_PATH" ]; then
  tar -zxf "$FULL_PATH" -C "$APP_PATH" --strip-components=1
  if [ $? -eq 0 ]; then
    echo "Extraction successful. Removing archive..."
    rm "$FULL_PATH"
    echo "Version: $TAG_NAME" > ${APP_PATH}/version
  else
    echo "Error: Extraction failed."
    exit 1
  fi
else
  echo "Error: Download failed."
  exit 1
fi

cat ${APP_PATH}/.env.example > ${APP_PATH}/.env

echo "Modify ${APP_PATH}/.env"
echo " . SESSION_SECRET"
echo " . GITHUB_APP_PRIVATE_KEY_PATH"
echo " . NVIDIA_API_KEY"
echo ""
 
echo "make setup"
echo "make create-admin ARGS='--username=yourname --password=yourpassword --initials=XX --admin'"
echo "# Finally #"
echo "make dev"
echo "make worker"
echo ""
echo "# add 'make doc-worker' to cronjobs"
echo ""
echo "(See README.md for details...)"

