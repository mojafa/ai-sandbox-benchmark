require('dotenv').config();
const express = require('express');
const { CodeSandbox } = require('@codesandbox/sdk');

// Add timestamp to logs
const log = (message, type = 'info') => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    switch(type) {
        case 'error':
            console.error(logMessage);
            break;
        case 'warn':
            console.warn(logMessage);
            break;
        default:
            console.log(logMessage);
    }
};

const app = express();
app.use(express.json());

// Enhanced environment validation
const requiredEnvVars = ['CSB_API_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    log(`Missing required environment variables: ${missingVars.join(', ')}`, 'error');
    process.exit(1);
}

log('Initializing CodeSandbox SDK...');
const sdk = new CodeSandbox(process.env.CSB_API_KEY);
log('CodeSandbox SDK initialized successfully');

// Add request logging middleware
app.use((req, res, next) => {
    log(`Incoming ${req.method} request to ${req.path}`);
    next();
});

// Status endpoint for health checks
app.get('/status', (req, res) => {
    res.json({
        status: 'ok',
        service: 'codesandbox-service',
        timestamp: new Date().toISOString()
    });
});

app.post('/execute', async (req, res) => {
    const requestId = Math.random().toString(36).substring(7);
    log(`[${requestId}] Starting code execution request`);

    const { code, env_vars } = req.body;
    if (!code) {
        log(`[${requestId}] No code provided in request`, 'error');
        return res.status(400).json({ error: 'No code provided' });
    }

    log(`[${requestId}] Code to execute: ${code.substring(0, 100)}${code.length > 100 ? '...' : ''}`);
    
    if (env_vars) {
        log(`[${requestId}] Environment variables provided: ${Object.keys(env_vars).join(', ')}`);
    }

    const startTime = Date.now();
    const metrics = {
        workspaceCreation: 0, // Renamed from initialization to workspaceCreation for consistency with Python script
        codeExecution: 0,
        cleanup: 0
    };

    let sandbox = null;

    try {
        const createStart = Date.now();
        log(`[${requestId}] Creating sandbox instance`);
        sandbox = await sdk.sandbox.create();
        metrics.workspaceCreation = Date.now() - createStart; // Measure workspace creation time
        log(`[${requestId}] Sandbox created successfully in ${metrics.workspaceCreation}ms`);

        // Pass environment variables to the sandbox if provided
        if (env_vars && Object.keys(env_vars).length > 0) {
            log(`[${requestId}] Setting up environment variables in sandbox`);
            
            let envSetupCode = "import os;\n";
            for (const [key, value] of Object.entries(env_vars)) {
                log(`[${requestId}] Setting ${key} in sandbox`);
                envSetupCode += `os.environ['${key}'] = '${value}';\n`;
            }
            
            await sandbox.shells.python.run(envSetupCode);
        }
        
        // Check for dependencies and install them if needed
        log(`[${requestId}] Checking for dependencies in code...`);
        const dependencyCheckerCode = `
import sys

# First, ensure the utils module is accessible
try:
    from providers.utils import check_and_install_dependencies
except ImportError:
    # If running in a fresh container, create the providers directory and utils.py
    import os, subprocess
    
    # Create providers directory if it doesn't exist
    if not os.path.exists('providers'):
        os.makedirs('providers')
        
    # Create __init__.py in providers directory
    with open('providers/__init__.py', 'w') as f:
        f.write('# Package initialization')
    
    # Create utils.py with necessary code
    with open('providers/utils.py', 'w') as f:
        f.write("""
import importlib
import re
import sys
from typing import List, Set, Optional, Dict, Any

def is_standard_library(module_name: str) -> bool:
    # Standard approach to detect standard library modules
    try:
        path = getattr(importlib.import_module(module_name), "__file__", "")
        return path and ("site-packages" not in path and "dist-packages" not in path)
    except (ImportError, AttributeError):
        # If import fails, we'll assume it's not a standard library
        return False

def extract_imports(code: str) -> Set[str]:
    # This regex pattern captures both 'import x' and 'from x import y' style imports
    pattern = r'^(?:from|import)\\s+([a-zA-Z0-9_]+)'
    imports = set()
    
    for line in code.split('\\n'):
        match = re.match(pattern, line.strip())
        if match:
            imports.add(match.group(1))
    
    return imports

def check_and_install_dependencies(
    code: str,
    provider_context: Optional[Dict[str, Any]] = None,
    always_install: Optional[List[str]] = None
) -> List[str]:
    import subprocess
    
    installed_packages = []
    
    # Install packages that should always be available
    if always_install:
        for package in always_install:
            try:
                importlib.import_module(package)
                print(f"Package {package} is already installed.")
            except ImportError:
                print(f"Installing required package: {package}")
                subprocess.check_call([sys.executable, "-m", "pip", "install", package])
                installed_packages.append(package)
    
    # Extract imports from the code
    imports = extract_imports(code)
    
    # Filter out standard library modules
    third_party_modules = {
        module for module in imports if not is_standard_library(module)
    }
    
    # Check each third-party module and install if missing
    for module in third_party_modules:
        try:
            importlib.import_module(module)
            print(f"Module {module} is already installed.")
        except ImportError:
            print(f"Installing missing dependency: {module}")
            # Use pip to install the package
            subprocess.check_call([sys.executable, "-m", "pip", "install", module])
            installed_packages.append(module)
    
    return installed_packages
""")
    
    # Import again after creating the file
    from providers.utils import check_and_install_dependencies

# The code string is passed in with triple quotes to handle any internal quotes
installed_packages = check_and_install_dependencies('''${code.replace(/'/g, "\\'")}''')
print(f"Installed packages: {installed_packages}")
`;

        const dependencyResult = await sandbox.shells.python.run(dependencyCheckerCode);
        log(`[${requestId}] Dependency check output: ${dependencyResult.output}`);
        
        const execStart = Date.now();
        log(`[${requestId}] Executing code in sandbox`);
        const result = await sandbox.shells.python.run(code);
        metrics.codeExecution = Date.now() - execStart; // Measure code execution time
        log(`[${requestId}] Code execution completed in ${metrics.codeExecution}ms`);
        log(`[${requestId}] Execution output: ${JSON.stringify(result.output)}`);

        const cleanupStart = Date.now();
        log(`[${requestId}] Starting sandbox cleanup`);
        await sandbox.hibernate();
        metrics.cleanup = Date.now() - cleanupStart; // Measure cleanup time
        log(`[${requestId}] Cleanup completed in ${metrics.cleanup}ms`);

        const totalTime = Date.now() - startTime;
        log(`[${requestId}] Total request processing time: ${totalTime}ms`);

        res.json({
            requestId,
            output: result.output,
            metrics: metrics,
            totalTime
        });

    } catch (error) {
        log(`[${requestId}] Error during execution: ${error.message}`, 'error');
        log(`[${requestId}] Error stack: ${error.stack}`, 'error');

        // Attempt cleanup if sandbox exists
        if (sandbox) {
            try {
                log(`[${requestId}] Attempting cleanup after error`);
                const cleanupStart = Date.now();
                await sandbox.hibernate();
                metrics.cleanup = Date.now() - cleanupStart; // Measure cleanup time even in error case
                log(`[${requestId}] Cleanup after error successful in ${metrics.cleanup}ms`);
            } catch (cleanupError) {
                log(`[${requestId}] Cleanup after error failed: ${cleanupError.message}`, 'error');
            }
        }

        res.status(500).json({
            requestId,
            error: error.message,
            metrics: metrics,
            errorDetails: {
                name: error.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            }
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    log(`Unhandled error: ${err.message}`, 'error');
    log(err.stack, 'error');
    res.status(500).json({
        error: 'Internal server error',
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    log(`CodeSandbox service running on port ${PORT}`);
    log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    log('Server is ready to accept requests');
});

// Handle process termination
process.on('SIGTERM', () => {
    log('SIGTERM received. Shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    log('SIGINT received. Shutting down gracefully');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    log(`Uncaught Exception: ${err.message}`, 'error');
    log(err.stack, 'error');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log('Unhandled Rejection at:', 'error');
    log(`Promise: ${promise}`, 'error');
    log(`Reason: ${reason}`, 'error');
});