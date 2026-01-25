#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Defaults
INCREMENT_TYPE="patch"
INTERACTIVE=true

# Parse arguments
for arg in "$@"; do
    case "$arg" in
        major|minor|patch)
            INCREMENT_TYPE="$arg"
            ;;
        -y|--yes|--non-interactive)
            INTERACTIVE=false
            ;;
        *)
            echo -e "${RED}Error: Unknown argument '$arg'${NC}"
            echo "Usage: $0 [major|minor|patch] [--non-interactive|--yes|-y]"
            echo "Default: patch"
            exit 1
            ;;
    esac
done

confirm() {
    local prompt="$1"
    if [ "$INTERACTIVE" = false ]; then
        return 0
    fi
    read -p "$prompt (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        return 1
    fi
    return 0
}

# Validate increment type
if [[ ! "$INCREMENT_TYPE" =~ ^(major|minor|patch)$ ]]; then
    echo -e "${RED}Error: Invalid increment type '$INCREMENT_TYPE'${NC}"
    echo "Usage: $0 [major|minor|patch] [--non-interactive|--yes|-y]"
    echo "Default: patch"
    exit 1
fi

# Get the latest tag
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [ -z "$LATEST_TAG" ]; then
    echo -e "${YELLOW}No existing tags found. Starting with v0.1.0${NC}"
    CURRENT_VERSION="0.1.0"
else
    # Extract version number (remove 'v' prefix if present)
    CURRENT_VERSION=${LATEST_TAG#v}
    echo -e "${GREEN}Current version: $CURRENT_VERSION${NC}"
fi

# Split version into major, minor, patch
IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR=${VERSION_PARTS[0]:-0}
MINOR=${VERSION_PARTS[1]:-0}
PATCH=${VERSION_PARTS[2]:-0}

# Increment version based on type
case $INCREMENT_TYPE in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    patch)
        PATCH=$((PATCH + 1))
        ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
NEW_TAG="v$NEW_VERSION"

echo -e "${GREEN}New version: $NEW_VERSION${NC}"
echo -e "${GREEN}New tag: $NEW_TAG${NC}"

# Check if tag already exists
if git rev-parse "$NEW_TAG" >/dev/null 2>&1; then
    echo -e "${RED}Error: Tag $NEW_TAG already exists${NC}"
    exit 1
fi

# Check if working directory is clean
if ! git diff-index --quiet HEAD --; then
    echo -e "${YELLOW}Warning: Working directory has uncommitted changes${NC}"
    if ! confirm "Continue anyway?"; then
        exit 1
    fi
fi

# Ensure we're on main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo -e "${RED}Error: Releases can only be created from main branch${NC}"
    echo -e "${YELLOW}Current branch: $CURRENT_BRANCH${NC}"
    exit 1
fi

# Check if current commit is pushed to remote
git fetch origin --quiet 2>/dev/null || true
LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse origin/main 2>/dev/null || echo "")

if [ -z "$REMOTE_COMMIT" ] || [ "$LOCAL_COMMIT" != "$REMOTE_COMMIT" ]; then
    echo -e "${YELLOW}Current commit is not pushed to remote${NC}"
    if confirm "Push main to origin?"; then
        echo -e "${GREEN}Pushing main to remote...${NC}"
        git push origin main
    else
        echo -e "${RED}Aborted: main must be pushed before release${NC}"
        exit 1
    fi
fi

# Create and push tag
echo -e "${GREEN}Creating tag: $NEW_TAG${NC}"
git tag -a "$NEW_TAG" -m "Release $NEW_TAG"

if confirm "Push tag $NEW_TAG to origin?"; then
    echo -e "${GREEN}Pushing tag to remote...${NC}"
    git push origin "$NEW_TAG"
else
    echo -e "${RED}Aborted: tag was created locally but not pushed${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Successfully created and pushed tag $NEW_TAG${NC}"
echo -e "${YELLOW}GitHub Actions will now build and publish the Docker image${NC}"

