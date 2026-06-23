terraform {
  required_version = ">= 1.3.0"

  required_providers {
    volterra = {
      source  = "volterraedge/volterra"
      version = ">= 0.11.38"
    }
    time = {
      source  = "hashicorp/time"
      version = ">= 0.9.0"
    }
    namecheap = {
      source  = "namecheap/namecheap"
      version = ">= 2.0.0"
    }
  }
}

provider "volterra" {
  api_p12_file = var.api_p12_file
  url          = var.api_url
  timeout      = "60s"
}

# Auth via env vars: NAMECHEAP_USER_NAME, NAMECHEAP_API_USER,
# NAMECHEAP_API_KEY, NAMECHEAP_CLIENT_IP
provider "namecheap" {
  use_sandbox = false
}
